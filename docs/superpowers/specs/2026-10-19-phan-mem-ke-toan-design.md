# Đặc tả thiết kế: Phần mềm kế toán doanh nghiệp Việt Nam

- Ngày lập: 2026-10-19
- Trạng thái: **bản nháp chờ duyệt** (chưa viết dòng mã nào)
- Căn cứ: báo cáo nghiên cứu `reports/Nghiệp vụ phần mềm kế toán.md` và 7 ghi chú trong `research_notes/Nghiệp vụ phần mềm kế toán/` (MISA, đối thủ Việt Nam, SUNSOFT PRO, mã nguồn mở quốc tế, mã nguồn mở Việt Nam và tích hợp, pháp lý, thiết kế sổ cái)
- Lộ trình thực hiện: `docs/superpowers/plans/2026-10-19-lo-trinh-thuc-hien.md`

## 1. Mục tiêu

Xây dựng một phần mềm kế toán doanh nghiệp "đầy đủ chức năng" cho thị trường Việt Nam, đạt mặt bằng nghiệp vụ mà kế toán viên đang quen với MISA SME/AMIS, Fast, SUNSOFT kỳ vọng, và tuân thủ pháp luật kế toán, thuế, hóa đơn điện tử có hiệu lực năm 2026. "Đầy đủ" được định nghĩa bằng danh sách nghiệp vụ ở mục 9; thứ tự xây dựng ở lộ trình.

## 2. Giả định (chưa xác nhận với người dùng, cần duyệt)

| # | Giả định | Nếu sai thì đổi gì |
|---|---|---|
| G1 | Đối tượng chính: doanh nghiệp nhỏ và vừa Việt Nam áp dụng TT 99/2025 (từ năm tài chính 2026) hoặc TT 133/2016; hộ kinh doanh (TT 152/2025) là phân khúc thứ hai | Nếu nhắm hộ kinh doanh trước, đẩy giai đoạn 7 lên sớm |
| G2 | Ứng dụng web (trình duyệt), tự host bằng Docker, sẵn sàng chạy SaaS nhiều công ty sau này | Nếu cần desktop offline, phải thêm lớp đồng bộ, không khuyến nghị |
| G3 | Một cơ sở dữ liệu chứa nhiều công ty và nhiều năm (không tách file theo năm như SUNSOFT/MISA SME) | Không thay đổi; đây là quyết định kiến trúc |
| G4 | Đội phát triển nhỏ (1–2 người cộng với trợ lý AI), ưu tiên đúng nghiệp vụ và tốc độ ra bản dùng được | Nếu đội lớn, các giai đoạn có thể chạy song song |
| G5 | Giao diện tiếng Việt; thuật ngữ, tên chứng từ, mẫu sổ theo thông tư; song ngữ để sau | — |
| G6 | Không làm kế toán hành chính sự nghiệp (TT 24/2024), ngân hàng, bảo hiểm, chứng khoán | — |
| G7 | Ngăn xếp công nghệ TypeScript + PostgreSQL (mục 5.2). Người dùng chưa cho biết sở thích ngôn ngữ | Đổi sang Python/Django hoặc .NET không ảnh hưởng mô hình dữ liệu và nghiệp vụ |

## 3. Kết luận nghiên cứu rút gọn

1. **Mặt bằng tối thiểu (baseline)** mọi phần mềm kế toán Việt Nam đều có: danh mục; số dư đầu kỳ; tiền mặt – ngân hàng; mua hàng – phải trả; bán hàng – phải thu; kho (thẻ kho, nhập xuất tồn, tính giá xuất kho); TSCĐ khấu hao; CCDC phân bổ; kết chuyển cuối kỳ tự động; sổ nhật ký chung, sổ cái, sổ chi tiết, bảng cân đối phát sinh; BCTC B01/B02/B03/B09 theo chế độ hiện hành; bảng kê và tờ khai GTGT xuất được sang HTKK (XML); xuất Excel; phân quyền; sao lưu.
2. **Điều kiện mới bắt buộc từ 2026**: (a) hệ thống tài khoản và BCTC theo TT 99/2025 kèm chuyển đổi số dư từ TT 200; (b) hóa đơn điện tử hai chiều (phát hành có mã/không mã, nhận hóa đơn đầu vào XML, xử lý điều chỉnh/thay thế) theo NĐ 123/2020 + NĐ 70/2025 đến 30/06/2026 và NĐ 254/2026 + TT 91/2026 từ 01/07/2026; (c) sổ hộ kinh doanh TT 152/2025 nếu nhắm hộ kinh doanh. Sản phẩm thiếu (b) bị loại ngay ở khâu mua sắm.
3. **Điều 28 TT 99/2025** đặt 6 yêu cầu với phần mềm kế toán: tuân thủ pháp luật kế toán/thuế; sửa chữa để lại dấu vết theo trình tự thời gian; cảnh báo và ngăn can thiệp có chủ ý; cung cấp đầy đủ dữ liệu đầu ra cho cơ quan có thẩm quyền; kết nối được với phần mềm khác; nâng cấp theo thay đổi pháp luật. Luật Kế toán Điều 27 chỉ cho sửa sổ điện tử bằng chứng từ điều chỉnh; Điều 19 yêu cầu chứng từ điện tử có chữ ký điện tử; lưu trữ 5/10 năm/vĩnh viễn (NĐ 174/2016).
4. **Bài học từ SUNSOFT PRO** (phân tích trực tiếp 941 form, 770 report, 119 bảng): một chứng từ gồm phần đầu và nhiều "trang" chi tiết (bút toán, vật tư, hóa đơn GTGT, tài sản) dùng chung một số thứ tự; sơ đồ kết chuyển/phân bổ là dữ liệu cấu hình (`DesHT_*`) chạy theo bước; BCTC và tờ khai định nghĩa theo dòng với công thức số dư tài khoản (`DesBC_*`) cho 7 chế độ kế toán; soát lỗi dữ liệu bằng bảng quy tắc SQL (`DesDataErr`); truy ngược từ mọi sổ về chứng từ. Điểm yếu phải tránh: một cơ sở dữ liệu mỗi năm, báo cáo phụ thuộc "đã cân đối đến tháng nào", không có khóa ngoại/transaction, audit trail không lưu giá trị cũ, mỗi dòng bút toán chỉ một cặp Nợ/Có, không có hóa đơn điện tử, không có kết nối ngân hàng.
5. **Bài học từ Odoo/ERPNext**: Odoo dùng `account_move`/`account_move_line` với ràng buộc cân bằng bằng SQL, 5 loại lock date, chuỗi hash theo sổ nhật ký; ERPNext tách chứng từ nguồn khỏi `GL Entry` bất biến, hủy bằng bút toán đảo. Cả hai phải thêm cơ chế đặc biệt để chịu sổ cái lớn. Không nên fork (LGPL/GPL, gắn chặt framework); nên học thiết kế và tái sử dụng dữ liệu mở (`l10n_vn` LGPL-3: danh mục tài khoản, thuế).
6. **Tích hợp**: chỉ Viettel SInvoice có API công khai (qua mã Odoo LGPL); MISA meInvoice chỉ công bố mô hình kết nối; HTKK không có XSD chính thức; ngân hàng cho SME đi qua SePay/Casso (webhook có tài liệu), VietinBank/BIDV có Open API cần ký hợp tác; VietQR theo chuẩn NAPAS; BHXH chỉ qua I-VAN; ký số từ xa theo TT 16/2019/TT-BTTTT.

## 4. Ba hướng tiếp cận

| Hướng | Mô tả | Ưu | Nhược | Kết luận |
|---|---|---|---|---|
| **A. Tự xây, học thiết kế từ Odoo/ERPNext/SUNSOFT** | Lõi sổ cái và toàn bộ nghiệp vụ viết mới trên PostgreSQL, tái sử dụng dữ liệu mở (danh mục TK, thuế) | Toàn quyền giấy phép và kiến trúc; mô hình dữ liệu đúng kiểu chứng từ Việt Nam; dễ tối ưu cho TT99/HĐĐT | Khối lượng lớn; phải tự xây report, in ấn, phân quyền | **Khuyến nghị** |
| B. Fork Odoo Community + `l10n_vn` | Dùng Odoo CE 19/20 làm nền, viết module Việt Nam | Có sẵn ERP, kho, thuế, báo cáo cơ bản; `l10n_vn` đã cập nhật TT99 | LGPL-3 buộc mở phần sửa lõi; phần TT200/TT133/BCTC của Viindoo là OPL-1 trả phí; TSCĐ, đánh giá lại ngoại tệ, BCTC động nằm ở Enterprise; UX không giống phần mềm kế toán Việt Nam; phụ thuộc framework Python/ORM Odoo | Chỉ chọn nếu cần ERP ngay và chấp nhận LGPL |
| C. Fork ERPNext | Dùng ERPNext (GPL-3) + viết app Việt Nam | Toàn bộ kho/TSCĐ/thuế khấu trừ/báo cáo đều mở | GPL-3 buộc mở mã dẫn xuất; không có chart Việt Nam chính thức; Frappe framework nặng; hiệu năng GL lớn đã phải vá | Không chọn |

## 5. Kiến trúc tổng thể

### 5.1 Hình dạng hệ thống

Modular monolith, một tiến trình API và một ứng dụng web, một cơ sở dữ liệu PostgreSQL, hàng đợi công việc chạy trên PostgreSQL. Ranh giới module (mỗi module có bảng, dịch vụ, API riêng; chỉ giao tiếp qua giao diện công khai):

| Module | Trách nhiệm |
|---|---|
| `core` | tenant/công ty, người dùng, vai trò, quyền, kỳ kế toán, khóa sổ, nhật ký kiểm toán, đánh số chứng từ, tùy chọn hệ thống |
| `coa` | hệ thống tài khoản đa chế độ (TT99/TT133/TT200/TT58), mẫu tài khoản, chuyển đổi chế độ |
| `ledger` | chứng từ và dòng chứng từ (sổ cái), máy trạng thái, số dư theo kỳ, kết chuyển/phân bổ theo sơ đồ, soát lỗi |
| `master` | danh mục dùng chung: đối tượng, VTHH, kho, bộ phận, nhân viên, vụ việc/công trình, khoản mục chi phí, hợp đồng, loại tiền, tỷ giá, ngân hàng |
| `cash` | phiếu thu/chi, báo nợ/báo có, UNC, sổ quỹ, sổ tiền gửi, tỷ giá xuất quỹ |
| `arap` | công nợ phải thu/phải trả, open items, đối trừ, bù trừ, tuổi nợ, biên bản đối chiếu, chênh lệch tỷ giá, đánh giá lại ngoại tệ |
| `purchase` / `sales` | đơn hàng, hợp đồng, chứng từ mua/bán hàng hóa và dịch vụ, trả lại/giảm giá, chiết khấu/khuyến mãi, chi phí mua hàng/nhập khẩu |
| `inventory` | phiếu nhập/xuất/chuyển kho, lắp ráp/tháo dỡ, lô/hạn dùng, đa ĐVT, kiểm kê, động cơ tính giá vốn (BQ cuối kỳ, BQ tức thời, FIFO, đích danh), nhập xuất tồn, thẻ kho |
| `assets` | TSCĐ, CCDC, chi phí trả trước, khế ước vay: thẻ, lịch khấu hao/phân bổ/trả nợ, chứng từ tự động |
| `tax` | động cơ thuế (GTGT, TTĐB, NK, TNCN khấu trừ), hóa đơn GTGT mua/bán kê khai, bảng kê, tờ khai 01/GTGT, 03/TNDN, 05/KK-TNCN, xuất XML HTKK/eTax |
| `einvoice` | adapter nhà cung cấp HĐĐT (SInvoice đầu tiên), vòng đời hóa đơn, nhận XML đầu vào theo QĐ 1450/QĐ-TCT, máy tính tiền |
| `payroll` | chấm công, bảng lương, BHXH, TNCN, hạch toán và chi lương |
| `costing` | tập hợp chi phí 621/622/627/154, định mức, giá thành giản đơn/hệ số/tỷ lệ/vụ việc/đơn hàng |
| `reporting` | định nghĩa báo cáo theo dòng, sổ sách theo 4 hình thức, BCTC, báo cáo quản trị, in liên tục, xuất Excel/PDF |
| `integrations` | ngân hàng (webhook SePay/Casso, nhập sao kê, VietQR), chữ ký số, tra cứu MST, email/Zalo |
| `web` | giao diện React: lưới nhập liệu điều khiển bằng bàn phím, màn hình chứng từ, báo cáo, cài đặt |

### 5.2 Ngăn xếp công nghệ đề xuất

| Lớp | Chọn | Lý do | Thay thế tương đương |
|---|---|---|---|
| Cơ sở dữ liệu | PostgreSQL 16+ | `NUMERIC`, generated columns, constraint trigger deferred, partition theo `posting_date`, row-level security cho đa thuê bao, advisory lock | Không thay |
| Ngôn ngữ/backend | TypeScript trên Node.js 22, Fastify, Kysely (SQL có kiểu) hoặc Drizzle, `decimal.js` cho tiền, Zod cho validation | Một ngôn ngữ cho cả API và web; kiểm soát SQL trực tiếp (quan trọng cho sổ cái); Bigcapital chứng minh TS đủ cho kế toán | Python 3.12 + Django/DRF (Decimal tốt, ORM mạnh, cùng họ với Odoo/ERPNext); .NET 8 (kiểu `decimal`, phổ biến ở doanh nghiệp Việt Nam) |
| Hàng đợi/việc nền | pg-boss (trên PostgreSQL) | Tính giá vốn, tính lại số dư, gửi HĐĐT, sao lưu không cần Redis | BullMQ + Redis |
| Web | React 18 + Vite, TanStack Router/Query, Ant Design 5 (bảng, form, ProTable), AG Grid Community cho lưới nhập liệu nhiều dòng | Giao diện dày dữ liệu, phím tắt, nhập liệu nhanh như MISA/SUNSOFT | Vue 3 + Element Plus |
| In ấn | Mẫu HTML + CSS in, xuất PDF bằng Chromium headless (Playwright); Excel bằng ExcelJS | Mẫu sổ theo thông tư là bảng; in liên tục nhiều sổ | — |
| Xác thực | Phiên (cookie) + mật khẩu băm Argon2, vai trò/quyền theo chức năng và cờ dữ liệu nhạy cảm, 2FA tùy chọn | Theo Luật Kế toán và TT99 Điều 28 | OIDC khi cần SSO |
| Kiểm thử | Vitest + fast-check (bất biến kế toán), Playwright (luồng người dùng) | Mục 14 | — |
| Triển khai | Docker Compose (api, web, postgres, worker), sao lưu `pg_dump` theo lịch | Tự host trước, SaaS sau | Kubernetes khi SaaS lớn |

## 6. Mô hình dữ liệu lõi

Quy ước khóa ngoại: giữa hai bảng cùng có `tenant_id` luôn là khóa tổng hợp `(tenant_id, x_id)` tham chiếu `cha (tenant_id, id)` (migration 0019), để không tham chiếu chéo công ty.

Các bảng dưới đây là xương sống; mọi bảng nghiệp vụ đều có `tenant_id` (công ty) và tham gia row-level security. Tiền hạch toán VND lưu `NUMERIC(20,0)`; ngoại tệ `NUMERIC(20,4)`; không dùng `float`/`money`.

```sql
-- Hệ thống tài khoản (một bản sao theo công ty, sinh từ mẫu chế độ kế toán)
CREATE TABLE account (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  regime text NOT NULL,                -- 'TT99' | 'TT133' | 'TT200' | 'TT58'
  code text NOT NULL,                  -- '111', '1111', '13111'
  name text NOT NULL, name_en text,
  parent_id bigint REFERENCES account(id),
  is_group boolean NOT NULL DEFAULT false,
  root_type text NOT NULL CHECK (root_type IN ('asset','liability','equity','income','expense','off_balance')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit','credit','both')),  -- 'both' = lưỡng tính (131, 331, 138, 338)
  track_currency boolean NOT NULL DEFAULT false,
  subledger_kind text,                 -- 'receivable'|'payable'|'inventory'|'fixed_asset'|'bank'|'cash'|NULL; dòng trên TK kiểm soát phải có đối tượng tương ứng
  reconcile boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, regime, code)
);

CREATE TABLE fiscal_period (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  fiscal_year int NOT NULL, period_no int NOT NULL,   -- 0 = kỳ mở sổ, 1..12, 13 = kỳ điều chỉnh
  date_from date NOT NULL, date_to date NOT NULL,
  regime text NOT NULL,                                -- chế độ kế toán áp dụng cho năm tài chính này
  status text NOT NULL CHECK (status IN ('open','soft_locked','hard_locked')),
  UNIQUE (tenant_id, fiscal_year, period_no)
);

-- Chứng từ (phần đầu) = một giao dịch kế toán nhiều dòng
CREATE TABLE voucher (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  voucher_type text NOT NULL,          -- 'PT','PC','BN','BC','UNC','HDB','HDM','PN','PX','PKT','KC','KH','PB', ...
  voucher_no text, seq_no bigint,      -- cấp khi ghi sổ, không lỗ hổng theo (voucher_type, fiscal_year)
  posting_date date NOT NULL,          -- ngày hạch toán
  document_date date NOT NULL,         -- ngày chứng từ
  state text NOT NULL CHECK (state IN ('draft','posted','reversed','cancelled')),
  description text,
  party_id uuid,                       -- đối tượng chính (người nộp/nhận, khách, NCC)
  currency_code char(3) NOT NULL DEFAULT 'VND', fx_rate numeric(20,10),
  source_doc_type text, source_doc_id uuid,   -- chứng từ nguồn (hóa đơn, phiếu kho, bảng lương, lịch khấu hao)
  reversal_of_id uuid REFERENCES voucher(id), reversed_by_id uuid REFERENCES voucher(id),
  is_closing boolean NOT NULL DEFAULT false,  -- bút toán kết chuyển, loại khỏi báo cáo KQKD
  idempotency_key text,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid, posted_at timestamptz,
  version int NOT NULL DEFAULT 1,
  prev_hash bytea, row_hash bytea,     -- chuỗi hash tính khi hard lock
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, voucher_type, voucher_no)
);

-- Dòng sổ cái
CREATE TABLE voucher_line (
  id bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL,
  voucher_id uuid NOT NULL REFERENCES voucher(id),
  line_no int NOT NULL,
  account_id bigint NOT NULL REFERENCES account(id),
  posting_date date NOT NULL,                       -- lặp từ voucher để index/partition
  currency_code char(3) NOT NULL,
  amount_currency numeric(20,4) NOT NULL,           -- có dấu: + Nợ, − Có
  debit numeric(20,0) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(20,0) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  balance numeric(20,0) GENERATED ALWAYS AS (debit - credit) STORED,
  -- chiều phân tích cốt lõi (cột cố định) + chiều mở rộng (jsonb)
  party_id uuid, item_id bigint, warehouse_id bigint, department_id bigint,
  project_id bigint, cost_item_id bigint, contract_id bigint, employee_id bigint, asset_id bigint,
  extra_dims jsonb NOT NULL DEFAULT '{}',
  description text, due_date date,
  CONSTRAINT one_side_only CHECK (debit = 0 OR credit = 0),
  PRIMARY KEY (id, posting_date),
  UNIQUE (voucher_id, line_no, posting_date)
) PARTITION BY RANGE (posting_date);
CREATE INDEX ON voucher_line (tenant_id, account_id, posting_date) INCLUDE (debit, credit);
CREATE INDEX ON voucher_line (tenant_id, party_id, posting_date);
```

Ràng buộc và bảng đi kèm:

- **Cân bằng**: constraint trigger `DEFERRABLE INITIALLY DEFERRED` kiểm tra `SUM(debit) = SUM(credit)` và `SUM(amount_currency) = 0` theo `(voucher_id, currency_code)` lúc COMMIT; đồng thời chỉ cho ghi dòng qua thủ tục `post_voucher()`.
- **Bất biến**: trigger chặn `UPDATE/DELETE` trên `voucher_line` khi `voucher.state = 'posted'` trừ khi phiên đang chạy `unpost()` có quyền và kỳ `open`.
- **Tài khoản kiểm soát**: nếu `account.subledger_kind` là `receivable/payable` thì `party_id NOT NULL`; `inventory` thì `item_id NOT NULL`; `fixed_asset` thì `asset_id NOT NULL`.
- **Trang chi tiết của chứng từ** (theo SUNSOFT): `voucher_item_line` (vật tư: số lượng, ĐVT, đơn giá, kho, lô, chiết khấu, thuế), `voucher_invoice` (hóa đơn GTGT kê khai: ký hiệu, số, ngày, MST, nhóm kê khai, tiền hàng, thuế), `voucher_asset_line`, `voucher_attachment`. Hóa đơn GTGT là dữ liệu kê khai riêng, nhiều hóa đơn trên một chứng từ, không trói vào dòng bút toán.
- **Số dư theo kỳ** `account_period_balance(tenant_id, account_id, fiscal_year, period_no, currency_code, party_id?, ...)` lưu riêng đầu kỳ Nợ/Có, phát sinh Nợ/Có, cuối kỳ Nợ/Có, cờ `is_stale`; ghi lùi ngày chỉ làm bẩn từ kỳ chứa ngày hiệu lực trở đi, worker tính lại; báo cáo đọc snapshot cộng phần dòng mới.
- **Công nợ**: `open_item(account_id, party_id, voucher_line_id, due_date, original_amount, currency)` + `settlement(open_item_id, settling_voucher_line_id, amount, fx_rate, exchange_diff_voucher_id)`; hủy đối trừ xóa `settlement` và đảo bút toán chênh lệch tỷ giá, không xóa sổ cái.
- **Kho**: `stock_move` (lượng, bất biến sau ghi sổ) tách khỏi giá: `stock_cost_layer` (lớp nhập và lớp điều chỉnh), `stock_cost_assignment` (giá gán cho dòng xuất, có phiên bản theo `costing_run`), `costing_run` (một lần tính/tính lại giá theo phương pháp, phạm vi, kỳ). Tính lại giá không sửa dòng sổ cái đã ghi: sinh một chứng từ điều chỉnh chênh lệch 632/155/156 trong kỳ mở gần nhất.
- **TSCĐ/CCDC/chi phí trả trước/khế ước vay**: thẻ + `schedule_line(date, amount, accumulated, voucher_id)`; mỗi kỳ bút toán tự động là chứng từ thật trỏ về dòng lịch; đổi nguyên giá/thời gian sinh lịch mới, lịch cũ giữ nguyên.
- **Thuế**: `tax(code, scope sale/purchase, amount_type percent/fixed/group, rate, price_include, exigibility on_invoice/on_payment)` + `tax_distribution(document_type invoice/refund, line_type base/tax, factor_percent, account_id, report_tags[])`; thuế khấu trừ tại nguồn mô hình bằng phân bổ âm. Tiền thuế làm tròn theo dòng, dòng "làm tròn" tự sinh để cân.
- **Sơ đồ kết chuyển/phân bổ**: `closing_step(order, name, mode 'transfer'|'allocate', from_accounts, to_account, keep_balance, by_dimension, ratio_source)`; chạy từng bước, mỗi bước sinh một chứng từ `KC`/`PB`; chạy lại bằng cách đảo chứng từ cũ.
- **Báo cáo theo dòng**: `report_def(regime, report_code B01/B02/B03/01GTGT...)` + `report_line(line_code, label, formula, balance_side debit/credit/net, parent_line)`; công thức theo mã tài khoản kiểu Odoo `account_codes` (`'111 + 112'`, `'131(1312)'`) mở rộng thêm điều kiện đối tượng/đối ứng; truy ngược từ chỉ tiêu về dòng chứng từ.
- **Quy tắc soát lỗi**: `data_check_rule(code, severity, sql, message, fix_hint)` chạy theo khoảng ngày, kết quả liên kết tới chứng từ.
- **Nhật ký kiểm toán**: `audit_event(ts, user_id, action, entity, entity_id, before jsonb, after jsonb, ip)` ghi mọi tạo/sửa/xóa/ghi sổ/bỏ ghi sổ/đối trừ/khóa; lưu cả giá trị trước và sau.
- **Đánh số**: `voucher_counter(tenant_id, voucher_type, fiscal_year, last_no)` cập nhật trong cùng transaction ghi sổ; cấu hình tiền tố/hậu tố/độ dài theo loại chứng từ và chi nhánh; hủy chứng từ đã đánh số giữ số (trạng thái `cancelled`), có tiện ích "đánh lại số" theo thứ tự ngày khi kỳ còn mở.

## 7. Quy tắc nghiệp vụ lõi

### 7.1 Máy trạng thái chứng từ

```
draft --post()--> posted --reverse()--> reversed   (chứng từ đảo mới ở trạng thái posted, reversal_of_id trỏ về gốc)
  ^                 |
  |   unpost()      |   chỉ khi kỳ 'open', chưa hash, người dùng có quyền "sửa sau ghi sổ"; ghi audit_event
  +-----------------+
draft --discard()--> cancelled   (giữ số nếu đã cấp)
```

| Tình huống | Kỳ `open` | Kỳ `soft_locked` (sau ngày khóa sổ) | Kỳ `hard_locked` / đã hash / đã nộp BCTC |
|---|---|---|---|
| Sửa diễn giải, chiều phân tích không đổi tiền/TK | Sửa tại chỗ + audit | Như kỳ open | Không |
| Sửa số tiền/tài khoản/ngày | `unpost()` → sửa → `post()`; dòng cũ lưu `voucher_line_history` | Chứng từ đảo ngày hiện tại + chứng từ mới | Chứng từ điều chỉnh ở kỳ mở gần nhất |
| Xóa | `discard()` → `cancelled` | Đảo | Không |
| Ghi lùi ngày vào kỳ | Cho phép | Chặn, trừ vai trò đặc biệt | Chặn tuyệt đối |

Cách này giữ UX "sửa trực tiếp trong kỳ mở" mà kế toán quen (MISA "bỏ ghi sổ", SUNSOFT sửa tại chỗ) nhưng vẫn để lại dấu vết theo Điều 28 TT99 và Điều 27 Luật Kế toán.

### 7.2 Kỳ kế toán và khóa sổ

Khóa theo kỳ (tháng) với ba mức; khóa riêng theo phần hành (quỹ, kho, công nợ) là cờ bổ sung trên kỳ. Chuỗi hash chỉ tính khi hard lock, kiểm tra lại được bằng công cụ độc lập. Kết chuyển cuối năm là chứng từ `KC` thật ngày 31/12 (hoặc ngày cuối năm tài chính) với `is_closing = true`; mở lại năm cũ là đảo chứng từ `KC`, sửa, chạy lại. Số dư đầu năm sau là số dư cuối kỳ 12 (hoặc kỳ 13) của tài khoản thuộc nhóm cân đối, không nhập tay lại; năm đầu tiên dùng kỳ 0 để nhập số dư đầu kỳ (tài khoản, công nợ theo đối tượng và hóa đơn, tồn kho theo kho/lô, TSCĐ, CCDC, vụ việc, thuế GTGT còn khấu trừ).

### 7.3 Chứng từ sinh tự động

Giá vốn (từ `costing_run`), khấu hao TSCĐ, phân bổ CCDC/chi phí trả trước, kết chuyển/phân bổ cuối kỳ, chênh lệch tỷ giá khi đối trừ, đánh giá lại ngoại tệ cuối kỳ, lãi vay theo khế ước, hạch toán lương: đều là chứng từ thật có số, ngày, người lập, `source_doc_*` trỏ về bảng sinh ra nó; chạy lại bằng đảo chứng từ cũ và sinh chứng từ mới, không sửa đè.

### 7.4 Ngoại tệ

Bảng tỷ giá theo ngày và loại (mua/bán chuyển khoản, trung bình); tỷ giá ghi sổ cho công nợ; chênh lệch tỷ giá thực hiện khi đối trừ (515/635); đánh giá lại số dư gốc ngoại tệ cuối kỳ (413 theo quy định của chế độ áp dụng); tỷ giá xuất quỹ theo phương pháp cấu hình. TT 99/2025 dùng một tỷ giá mua bán chuyển khoản trung bình của ngân hàng thương mại (theo ghi nhận của MISA), cần xác nhận trong văn bản gốc.

## 8. Chế độ kế toán đa phiên bản

- Mẫu hệ thống tài khoản, mẫu chứng từ, mẫu sổ, mẫu BCTC và định nghĩa dòng báo cáo được lưu theo `regime`: `TT99` (mặc định cho năm tài chính từ 2026), `TT133` (DNNVV), `TT200` (dữ liệu 2025 trở về trước và đối chiếu), `TT58` (siêu nhỏ, từ 01/07/2026, tùy chọn), `TT152` (hộ kinh doanh, giai đoạn sau).
- Công ty chọn chế độ cho từng năm tài chính (`fiscal_period.regime`). Tiện ích chuyển đổi số dư TT200 → TT99 theo bảng ánh xạ (ví dụ tài khoản bỏ 161, 417, 441, 461, 466, 611, 631, 1562, 3385; tài khoản thêm 137, 215/2295, 246, 332, 351, 1383; chuyển 441/466 → 4118, 338 → 332) với nhật ký chuyển đổi; bảng ánh xạ phải được đối chiếu với Phụ lục II TT99 trước khi phát hành (các nguồn thứ cấp mâu thuẫn về 1385, 6275, 82111/82112: ghi chú pháp lý nói 1385 bị bỏ, báo cáo tổng hợp nói được thêm).
- Dữ liệu khởi tạo: tái sử dụng CSV tài khoản và thuế của Odoo `l10n_vn` (LGPL-3, giữ nguyên ghi công) kết hợp danh mục `OrgDMTK` (TT133, 133 tài khoản) và `OrgDMTK_200` (TT200, 243 tài khoản) trích từ SUNSOFT làm đối chiếu; TT99 nhập tay từ văn bản gốc.
- Dòng BCTC theo chế độ: TT99 có B01-DN "Báo cáo tình hình tài chính" (117 chỉ tiêu theo SUNSOFT `DesBC_CDKT_B01_99`), B02-DN (28 chỉ tiêu), B03-DN trực tiếp (32 chỉ tiêu); TT133 có B01a/B01b/B01-DNN, B02-DNN, B03-DNN; mỗi bộ là dữ liệu, không phải mã.

## 9. Phân hệ và nghiệp vụ

Ký hiệu: **B** = Baseline (mọi phần mềm Việt Nam đều có, bắt buộc), **D** = Differentiator (MISA/Fast có, tạo khác biệt), **N** = Niche (một số vendor hoặc theo ngành). Số trong ngoặc là giai đoạn ở lộ trình.

| Phân hệ | Nghiệp vụ | Mức | GĐ |
|---|---|---|---|
| Hệ thống | Công ty, năm tài chính, kỳ, chế độ kế toán, tùy chọn (hình thức sổ, phương pháp giá vốn, tiền tệ, đánh số, ẩn/hiện nghiệp vụ, trường mở rộng) | B | 0 |
| | Người dùng, vai trò, quyền theo chức năng (xem/thêm/sửa/xóa/in/ghi sổ) + cờ dữ liệu nhạy cảm (giá vốn, công nợ, lương), nhật ký truy cập và lịch sử sửa/xóa có giá trị trước/sau | B | 0 |
| | Khóa sổ theo kỳ/phần hành, bỏ khóa có quyền, hash khi hard lock | B | 1 |
| | Sao lưu/phục hồi theo lịch, xuất toàn bộ dữ liệu cho cơ quan thẩm quyền (Điều 28 TT99) | B | 0, 1 |
| Danh mục | Hệ thống tài khoản dạng cây đa chế độ; đổi số hiệu/ghép tài khoản có dữ liệu | B | 0, 1 |
| | Đối tượng dùng chung (khách, NCC, nhân viên, khế ước vay): nhóm, MST/CCCD, địa chỉ hóa đơn, tài khoản ngân hàng, hạn thanh toán, hạn mức nợ, nhân viên phụ trách | B | 0 |
| | VTHH: cây nhóm, đa ĐVT có hệ số, tính chất (hàng hóa/NVL/thành phẩm/dịch vụ/CCDC), thuế suất mặc định, lô/hạn dùng, tồn min/max, bảng giá bán/mua, mã quy cách, vị trí | B (lô/HSD, quy cách: D) | 0, 3 |
| | Kho (TK kho, phương pháp giá vốn riêng, kho gửi bán), bộ phận/chi nhánh, nhân viên, loại tiền + bảng tỷ giá, ngân hàng và tài khoản ngân hàng, hình thức thanh toán, loại thuế, nhóm hóa đơn mua (theo mục tờ khai) và bán | B | 0 |
| | Vụ việc/công trình (cây), khoản mục chi phí, đối tượng tập hợp chi phí, yếu tố chi phí, hợp đồng mua/bán, đơn hàng, mã thống kê (chiều mở rộng) | B/D | 0, 6 |
| | Loại TSCĐ/CCDC, nguồn vốn, lý do tăng giảm, tham số khấu hao/phân bổ gắn TK chi phí/bộ phận/vụ việc | B | 4 |
| | Nhập khẩu danh mục từ Excel theo mẫu; thêm nhanh danh mục ngay tại ô mã | B | 0 |
| Số dư đầu kỳ | Tài khoản (VND/ngoại tệ, đúng loại dư), công nợ chi tiết theo đối tượng và hóa đơn, tồn kho theo kho/lô, TSCĐ, CCDC, chi phí trả trước, chi phí dở dang, vụ việc, doanh thu nhận trước, thuế GTGT còn khấu trừ; nhập Excel; kiểm tra chênh lệch số dư chi tiết với tài khoản | B | 1–4 |
| Quỹ | Phiếu thu/chi (VND, ngoại tệ), nhiều bút toán, nhiều đối tượng, thu/chi từ hóa đơn, tạm ứng/quyết toán tạm ứng, nộp thuế/BHXH, sổ quỹ, kiểm kê quỹ, dự báo dòng tiền | B (dự báo: D) | 2 |
| Ngân hàng | Báo nợ/báo có, UNC in theo mẫu ngân hàng, chuyển tiền nội bộ, séc, sổ tiền gửi, đối chiếu sổ phụ, nhập sao kê Excel, webhook giao dịch (SePay/Casso), VietQR trên hóa đơn | B (webhook/VietQR: D) | 2, 5 |
| Mua hàng – phải trả | Đơn mua, hợp đồng mua, chứng từ mua hàng (qua kho/không qua kho/dịch vụ/nhập khẩu với thuế NK và chi phí mua hàng phân bổ), hàng về trước hóa đơn về sau và ngược lại, trả lại/giảm giá, chiết khấu, công nợ phải trả, đối trừ/bù trừ, lịch thanh toán, hóa đơn đầu vào từ XML HĐĐT, kiểm tra tình trạng MST người bán | B (đơn mua, XML, MST: D) | 2, 3, 5 |
| Bán hàng – phải thu | Báo giá, đơn đặt hàng, hợp đồng bán, chứng từ bán hàng (kiêm hóa đơn/phiếu xuất/bút toán, bảng kê kèm hóa đơn), bán dịch vụ, xuất khẩu, chiết khấu/khuyến mãi/giảm giá/trả lại, bán qua đại lý, chính sách giá, công nợ phải thu, tuổi nợ, kế hoạch thu nợ, biên bản đối chiếu, doanh thu nhận trước phân bổ, lãi gộp theo khách/mặt hàng/nhân viên | B (chính sách giá, doanh thu nhận trước: D) | 2, 3 |
| Kho | Nhập (mua, thành phẩm, trả lại, chuyển đến, gia công về, ký gửi), xuất (bán, sản xuất, điều chuyển, trả NCC, biếu tặng, hủy, gia công, định mức), chuyển kho, lắp ráp/tháo dỡ, kiểm kê, cảnh báo tồn âm/xuất quá tồn, lô/HSD, đa ĐVT, mã vạch; tính giá vốn 4 phương pháp theo kho/kỳ, cập nhật ngược bút toán giá vốn qua chứng từ điều chỉnh, cố định giá vốn; NXT, thẻ kho, sổ chi tiết, đối chiếu kế toán – thủ kho | B (mã vạch, vị trí: D) | 3 |
| CCDC – chi phí trả trước | Ghi tăng (mua dùng ngay, từ kho, từ TSCĐ), giảm, điều chuyển, điều chỉnh, kiểm kê, phân bổ nhiều kỳ theo bộ phận/vụ việc, sổ theo dõi | B | 4 |
| TSCĐ | Ghi tăng (mua, XDCB, góp vốn, thuê tài chính), giảm (thanh lý, góp vốn), đánh giá lại, điều chuyển, kiểm kê, khấu hao đường thẳng (số dư giảm dần, sản lượng: N), dừng khấu hao, thẻ TSCĐ, sổ TSCĐ, bảng tính khấu hao | B | 4 |
| Khế ước vay | Hợp đồng tín dụng, giải ngân, lịch trả nợ, lãi vay, tất toán, báo cáo | D | 4 |
| Tổng hợp | Phiếu kế toán/chứng từ nghiệp vụ khác, chứng từ ghi sổ, hạch toán ngoại tệ, tỷ giá xuất quỹ, đánh giá lại ngoại tệ, phân bổ chi phí bán hàng/QLDN theo vụ việc, kết chuyển lãi lỗ theo sơ đồ nhiều bước, kết chuyển lợi nhuận năm nay sang năm trước, kiểm tra đối chiếu sổ sách bằng quy tắc, ghi sổ/bỏ ghi sổ theo lô, đánh lại số chứng từ, khóa sổ | B | 1, 2 |
| Thuế | Thuế GTGT khấu trừ (bảng kê mua vào/bán ra, tờ khai 01/GTGT, điều chỉnh, còn khấu trừ chuyển kỳ, hoàn), GTGT trực tiếp, TNDN (tạm nộp quý, quyết toán 03/TNDN và phụ lục, điều chỉnh tăng/giảm), TNCN (khấu trừ, 05/KK-TNCN quý, quyết toán), TTĐB, thuế NK/XK, thuế tài nguyên; xuất XML HTKK/eTax; kiểm tra trùng hóa đơn, MST bỏ trốn; mẫu TT 80/2021 cho kỳ trước 01/07/2026 và TT 89/2026 sau đó | B (TTĐB, tài nguyên: N) | 2, 5 |
| Hóa đơn điện tử | Phát hành có mã/không mã, ký số (USB token qua tiện ích ký cục bộ, ký từ xa), gửi CQT, tra cứu trạng thái, điều chỉnh/thay thế, thông báo sai sót 04/SS-HĐĐT, hóa đơn máy tính tiền, nhận và lưu XML đầu vào, lập chứng từ từ hóa đơn; adapter: SInvoice trước, meInvoice/VNPT/BKAV sau | B từ 2022 | 5 |
| Tiền lương | Chấm công, bảng lương theo cấu trúc cấu hình, BHXH/BHYT/BHTN (tỷ lệ, trần, sàn), TNCN lũy tiến 5 bậc (từ kỳ 2026) và giảm trừ, hạch toán chi phí lương theo bộ phận, chi lương theo lô, chứng từ khấu trừ TNCN, báo cáo | B (lương hoa hồng: D) | 6 |
| Giá thành | Tập hợp chi phí 621/622/627 theo đối tượng, định mức NVL, dở dang, phân bổ theo tiêu thức, giá thành giản đơn, hệ số/tỷ lệ, vụ việc/công trình, đơn hàng/hợp đồng; phân bước nhiều công đoạn (N) | B cho DN sản xuất/xây lắp | 6 |
| Hợp đồng – vụ việc | Theo dõi thu/chi/doanh số/thực hiện theo hợp đồng, đợt thanh toán, sinh hóa đơn từ hợp đồng, lãi lỗ theo vụ việc | D | 6 |
| Ngân sách | Dự toán theo khoản mục/bộ phận, cảnh báo vượt dự toán | N | 7 |
| Sổ sách – báo cáo | Nhật ký chung, nhật ký đặc biệt, sổ cái (theo chứng từ/tiểu khoản/chữ T), sổ chi tiết tài khoản, bảng cân đối phát sinh (có cộng cấp, tách dư hai bên theo đối tượng), sổ quỹ, sổ tiền gửi, sổ công nợ (chi tiết/tổng hợp/tuổi nợ/biên bản), sổ kho/NXT/thẻ kho, sổ TSCĐ/CCDC, sổ chi phí theo khoản mục, sổ giá thành, BCTC B01/B02/B03/B09 theo chế độ (so sánh năm trước, niên độ lệch, giữa niên độ, truy ngược chỉ tiêu), báo cáo thuế, báo cáo quản trị (doanh thu, chi phí, lãi gộp, công nợ, tồn kho), in liên tục cả bộ sổ, xuất Excel/PDF, mẫu in chứng từ theo thông tư và theo ngân hàng, gửi email | B | 1–6 |
| | Hình thức sổ: Nhật ký chung trước; Chứng từ ghi sổ, Nhật ký – Sổ cái, Nhật ký – Chứng từ sau; BCTC tổng hợp nhiều chi nhánh; hợp nhất TT 202; song ngữ; phân tích tài chính/dashboard | D/N | 7 |
| Tiện ích | Soát lỗi chứng từ theo quy tắc, kiểm tra chênh lệch kho/công nợ/thuế với sổ cái, xác nhận chứng từ, khử trùng chứng từ (hai kế toán nhập cùng nghiệp vụ), nhập chứng từ từ Excel/bảng kê, nhân bản, in nhiều mẫu, nhớ bộ lọc theo người dùng, trợ giúp ngữ cảnh, nhật ký phiên bản | B | 1–3 |
| Hộ kinh doanh | Sổ S1a/S2a/S2b–S2e/S3a-HKD theo TT 152/2025, tờ khai 01/CNKD, hóa đơn máy tính tiền, ngưỡng miễn 1 tỷ (NĐ 141/2026) | N (thị trường mới từ 2026) | 7 |

## 10. Tham số pháp lý phải mã hóa (tính đến 10/2026)

| Nhóm | Giá trị | Hiệu lực | Nguồn |
|---|---|---|---|
| Chế độ kế toán DN | TT 99/2025/TT-BTC thay TT 200 (trừ k.2 Đ31), TT 75/2015, TT 53/2016, TT 195/2012 | Năm tài chính từ 01/01/2026 | TT 99/2025 |
| DNNVV | TT 133/2016 còn hiệu lực (trong lộ trình sửa) | — | QĐ 3389/QĐ-BTC |
| DN siêu nhỏ | TT 58/2026 thay TT 132/2018 | 01/07/2026 | TT 58/2026 |
| Hộ kinh doanh | TT 152/2025 thay TT 88/2021; bỏ thuế khoán | 01/01/2026 | NQ 198/2025, Luật 108/2025 Đ13 |
| GTGT | 0/5/10%; giảm 2% (10 → 8%) đến 31/12/2026; ngưỡng không dùng tiền mặt 5 triệu | 01/07/2025 | Luật 48/2024, NĐ 181/2025, NQ 204/2025, NĐ 174/2025 |
| TNDN | 20%; 15% (DT ≤ 3 tỷ); 17% (3–50 tỷ); miễn DT ≤ 1 tỷ; tạm nộp 4 quý ≥ 80% | Kỳ 2025 (15/17/20), NĐ 141/2026 | Luật 67/2025, NĐ 320/2025, NĐ 141/2026, NĐ 252/2026 |
| TNCN | 5 bậc 5/10/20/30/35% (mốc 10/30/60/100 triệu/tháng); giảm trừ 15,5 triệu/6,2 triệu; y tế – giáo dục tối đa 47 triệu/năm | Kỳ 2026; Luật hiệu lực 01/07/2026 | Luật 109/2025, NQ 110/2025/UBTVQH15, NĐ 253/2026 |
| BHXH | Tổng 32% (DN 21,5%: 14 + 3 + 0,5 + 3 + 1; NLĐ 10,5%: 8 + 1,5 + 1); trần 20 × mức tham chiếu: 46,8 triệu đến 30/06/2026, 50,6 triệu từ 01/07/2026 | 2026 | Luật 41/2024, NĐ 158/2025, NĐ 161/2026 |
| Lương tối thiểu vùng | 5.310.000 / 4.730.000 / 4.140.000 / 3.700.000 | 01/01/2026 | NĐ 293/2025 |
| Làm thêm | 150/200/300%, đêm +30%, thêm giờ đêm +20% | — | BLLĐ 2019 Đ98 |
| Lệ phí môn bài | Bãi bỏ | 01/01/2026 | NQ 198/2025 k7 Đ10, NĐ 362/2025 |
| Quản lý thuế, tờ khai | Luật 108/2025 + NĐ 252/2026 + TT 89/2026 (thay TT 80/2021); TNCN tiền lương khai quý; mẫu cũ cho kỳ trước 01/07/2026 | 01/07/2026 | TT 89/2026 Đ22, Đ100 |
| Hóa đơn điện tử | NĐ 123/2020 + NĐ 70/2025 + TT 32/2025 đến 30/06/2026; NĐ 254/2026 + TT 91/2026 từ 01/07/2026; định dạng XML QĐ 1450/QĐ-TCT (sửa bởi QĐ 1510/QĐ-TCT) | 01/06/2025; 01/07/2026 | — |
| Chữ ký điện tử | Luật GDĐT 20/2023, NĐ 23/2025; ký số từ xa TT 16/2019/TT-BTTTT | 10/04/2025 | — |
| Dữ liệu cá nhân, lưu trữ | Luật 91/2025 + NĐ 356/2025 (01/01/2026); Luật An ninh mạng 116/2025 (01/07/2026): dữ liệu người dùng lưu tại Việt Nam | 2026 | — |
| Lưu trữ kế toán | 5/10 năm/vĩnh viễn; sổ điện tử in được sau khóa sổ | — | Luật KT Đ26, Đ27, Đ41; NĐ 174/2016 |

Mọi tham số lưu trong bảng `legal_param(code, value, valid_from, valid_to, source)` và được chọn theo ngày hiệu lực, không hard-code.

## 11. Tích hợp

| Bề mặt | Cách làm | Ghi chú |
|---|---|---|
| Hóa đơn điện tử | Giao diện `EInvoiceProvider` (createInvoice, search, cancel/adjust/replace, getPdf/Xml, sendErrorNotice); adapter SInvoice (REST `api-vinvoice.viettel.vn`, đăng nhập lấy token, JSON `generalInvoiceInfo/buyerInfo/sellerInfo/itemInfo/taxBreakdowns`) làm chuẩn; adapter meInvoice/VNPT/BKAV khi có tài liệu hoặc hợp tác | Lưu XML gốc đã ký; parse `TDiep/DLieu/HDon` theo QĐ 1450 cho hóa đơn đầu vào |
| Thuế | Sinh XML tờ khai theo định dạng HTKK (mẫu lấy bằng cách kết xuất từ HTKK 5.x và đối chiếu), người dùng nộp qua eTax; sau này tích hợp T-VAN | Không có XSD chính thức; cần bộ mẫu kiểm thử từ HTKK |
| Ngân hàng | Webhook SePay/Casso (HMAC/API key) ghi giao dịch vào hộp thư chờ đối chiếu; nhập sao kê Excel/CSV theo mẫu từng ngân hàng; VietQR (NAPAS EMVCo) in trên hóa đơn/phiếu; Open API VietinBank eFAST/BIDV khi có hợp đồng | Không chuyển tiền tự động trong phạm vi này |
| Chữ ký số | USB token: tiện ích ký cục bộ (ứng dụng nhỏ trên máy người dùng nhận hash qua localhost, trả chữ ký PKCS#7/XML-DSig); ký từ xa: VNPT SmartCA/Viettel/FPT theo chuẩn CEN EN 419 241 | Cần cho HĐĐT, tờ khai, BCTC, và chứng từ điện tử theo Luật KT Đ19 |
| Tra cứu | MST doanh nghiệp (`api.vietqr.io/v2/business/{taxCode}` hoặc cổng Tổng cục Thuế), tra cứu hóa đơn trên `hoadondientu.gdt.gov.vn` | Cảnh báo người bán ngừng hoạt động |
| BHXH | Xuất file theo mẫu I-VAN (eBH/VNPT/EFY) | Không có đặc tả công khai |
| Bán hàng/POS, Excel | Nhập chứng từ từ Excel theo mẫu (bảng kê mua/bán, phiếu thu/chi), API REST có khóa cho phần mềm bán hàng | — |

## 12. Báo cáo và in ấn

- Mọi báo cáo đọc từ `account_period_balance` cộng dòng mới; truy ngược hai cấp: chỉ tiêu → tài khoản/đối tượng → chứng từ; mở chứng từ, sửa, xem lại.
- Định nghĩa dòng BCTC/tờ khai là dữ liệu theo chế độ (mục 6, 8); người dùng có quyền sửa công thức và nạp lại mẫu.
- Mẫu in: HTML/CSS theo đúng mẫu số (S03a-DN, S03b-DN, 01-TT, 02-TT, 01-VT, 02-VT, …) với tiêu đề "Mẫu số … Ban hành theo …" lấy từ chế độ áp dụng; in liên tục cả bộ sổ năm; xuất Excel nhiều sheet; PDF.
- Hình thức sổ Nhật ký chung trước (đủ cho đa số doanh nghiệp theo khảo sát); các hình thức khác là lớp trình bày trên cùng dữ liệu.

## 13. Bảo mật, phân quyền, đa thuê bao, sao lưu

- Đa thuê bao kiểu pool: `tenant_id` trên mọi bảng, `FORCE ROW LEVEL SECURITY`, vai trò ứng dụng không phải owner, `SET LOCAL app.current_tenant` trong transaction; thiết kế cho phép tách một tenant lớn sang DB riêng.
- Quyền: vai trò gồm tập quyền theo chức năng (xem/thêm/sửa/xóa/in/ghi sổ/bỏ ghi sổ/khóa) và cờ dữ liệu nhạy cảm; phạm vi theo chi nhánh.
- Nhật ký: `audit_event` đầy đủ trước/sau, không xóa được; nhật ký đăng nhập; chuỗi hash khi hard lock; xuất toàn bộ dữ liệu kế toán theo kỳ ra bộ file (CSV/XML/PDF sổ) cho cơ quan thẩm quyền.
- Sao lưu `pg_dump` theo lịch, lưu nhiều phiên bản, phục hồi thử định kỳ; dữ liệu lưu tại Việt Nam khi chạy SaaS.
- Dữ liệu cá nhân (CCCD, lương): mã hóa cột nhạy cảm, che theo quyền, nhật ký truy cập.
- Quy ước mã lỗi: mã kết thúc `_NOT_FOUND` luôn 404 (đối tượng nêu tên không tồn tại hoặc không thấy được trong công ty), kể cả khi phát sinh từ `RAISE` trong SQL; trạng thái không cho thao tác (kỳ khóa, chứng từ đã ghi sổ) giữ 409 với mã riêng.

## 14. Kiểm thử

Property-based (fast-check) cho bất biến kế toán, chạy trên PostgreSQL thật:

1. Mọi chứng từ ghi sổ: `SUM(debit) = SUM(credit)` và `SUM(amount_currency) = 0` theo loại tiền; chứng từ lệch bị từ chối.
2. Chuỗi ngẫu nhiên post/reverse/unpost/ghi lùi ngày: số dư snapshot bằng `SUM` từ dòng tại mọi ngày; gốc + đảo = 0 trên mọi tài khoản và đối tượng.
3. Cùng `idempotency_key` lặp k lần: đúng một chứng từ.
4. Tài sản = Nợ phải trả + Vốn chủ sở hữu tại mọi ngày; tài khoản trung gian về 0 sau quy trình cuối kỳ.
5. Sub-ledger ↔ sổ cái: tổng `open_item.residual` = số dư tài khoản công nợ; tổng `stock_cost_layer.remaining_value` = số dư 152/155/156; tổng giá trị còn lại TSCĐ = 211 − 214.
6. Kỳ `hard_locked` từ chối mọi ghi, kể cả đảo.
7. Bộ dữ liệu mẫu một năm (doanh nghiệp thương mại có kho, ngoại tệ, TSCĐ) với BCTC kỳ vọng tính tay; so khớp từng chỉ tiêu B01/B02/B03.
8. Playwright cho luồng nhập liệu bằng bàn phím và in sổ.

## 15. Rủi ro và khoảng trống

| Rủi ro / khoảng trống | Ảnh hưởng | Xử lý |
|---|---|---|
| Chưa đọc được văn bản gốc TT 99/2025 (Điều 28–31, Phụ lục II hệ thống tài khoản), Phụ lục I TT 89/2026 (mẫu tờ khai), Phụ lục TT 91/2026 (ký hiệu hóa đơn), phụ lục QĐ 1450/1510 (XML) | Danh mục tài khoản, công thức BCTC, XML có thể sai chi tiết | Mua/tải văn bản gốc từ Công báo trước giai đoạn 0; đối chiếu với `OrgDMTK*` và `DesBC_*_99` của SUNSOFT |
| HTKK không có XSD | Tờ khai XML có thể bị eTax từ chối | Kết xuất mẫu từ HTKK thật cho từng tờ khai, viết kiểm thử đối chiếu |
| API HĐĐT của MISA/VNPT/BKAV không công khai | Chỉ SInvoice làm được ngay | Thiết kế adapter; ký hợp tác nhà cung cấp hoặc dùng cổng T-VAN |
| Khối lượng nghiệp vụ lớn (SUNSOFT 941 form, MISA 20 phân hệ) | Dễ lan man | Lộ trình theo giai đoạn, mỗi giai đoạn ra bản dùng được; mức B trước D/N |
| Tính giá vốn và tính lại số dư khi ghi lùi ngày | Lỗi số liệu khó phát hiện | Bất biến kiểm thử (mục 14), advisory lock theo (mặt hàng, kho), không sửa dòng đã ghi |
| Thay đổi pháp luật liên tục (2025–2026 đổi gần như toàn bộ luật thuế) | Phải cập nhật thường xuyên | Tham số theo ngày hiệu lực; định nghĩa báo cáo là dữ liệu; chế độ theo năm tài chính |
| Dữ liệu khách hàng SUNSOFT trong thư mục tham chiếu | Rủi ro riêng tư | Chỉ dùng schema và bảng tham chiếu; không mở dữ liệu giao dịch |

## 16. Lộ trình (tóm tắt)

| GĐ | Tên | Kết quả dùng được | Ước lượng |
|---|---|---|---|
| 0 | Nền tảng | Đăng nhập, công ty, kỳ, hệ thống tài khoản TT99/TT133, danh mục khung, nhật ký kiểm toán, nhập Excel | 2–3 tuần |
| 1 | Lõi sổ cái | Phiếu kế toán, ghi sổ/bỏ ghi sổ, khóa kỳ, số dư, NKC/sổ cái/sổ chi tiết/BCĐPS, kết chuyển theo sơ đồ, BCTC TT99 + TT133, xuất Excel/PDF; đủ cho doanh nghiệp dịch vụ không kho | 5–6 tuần |
| 2 | Tiền, công nợ, thuế GTGT | Thu/chi/ngân hàng, đối tượng, đối trừ, ngoại tệ, hóa đơn mua/bán dịch vụ, bảng kê, 01/GTGT, XML HTKK | 5–6 tuần |
| 3 | Kho và mua bán hàng hóa | VTHH, kho, nhập/xuất/chuyển, mua/bán hàng hóa, giá vốn 4 phương pháp, NXT/thẻ kho/kiểm kê | 6–8 tuần |
| 4 | Tài sản và khế ước | TSCĐ, CCDC, chi phí trả trước, khế ước vay, chứng từ tự động | 4 tuần |
| 5 | Hóa đơn điện tử và tích hợp | SInvoice, XML đầu vào, ký số, ngân hàng webhook/sao kê/VietQR, tra cứu MST, TNDN/TNCN tờ khai | 5–6 tuần |
| 6 | Lương, giá thành, hợp đồng | Bảng lương/BHXH/TNCN, giá thành 4 phương pháp, định mức, hợp đồng/vụ việc | 5–6 tuần |
| 7 | Mở rộng | Hộ kinh doanh TT152, TT58, hình thức sổ khác, đa chi nhánh/hợp nhất, ngân sách, song ngữ, mobile, trợ lý AI | liên tục |

Chi tiết từng giai đoạn ở `docs/superpowers/plans/2026-10-19-lo-trinh-thuc-hien.md`. Sau khi đặc tả này được duyệt (đặc biệt mục 2 và 5.2), bước tiếp theo là viết kế hoạch thực hiện chi tiết theo từng tác vụ (có mã, có kiểm thử) cho giai đoạn 0 và 1.
