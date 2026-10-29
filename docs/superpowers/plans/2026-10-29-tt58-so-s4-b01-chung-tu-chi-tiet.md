# TT 58/2026: S4a, S4b, S4d, B01-DNSN, chứng từ 01-TT, 02-TT, 01-VT, 02-VT (kế hoạch ngắn)

Nguồn duy nhất: văn bản gốc `~/Documents/PetProject/legal-docs-gd7/tt58-2026/tt58-2026.txt` (Công báo số 323): Điều 9 khoản 1.1, 1.2, 1.4 (S4a, S4b, S4d), khoản 2 (chứng từ), Điều 10 khoản 2.2.1 (B01-DNSN). Sổ quyết định `2026-10-29-tt58-so-s4-b01-quyet-dinh.md` (1620 trở đi). Migration 0291.

Phạm vi và mô hình: giữ mô hình ghi sổ đơn của GĐ7 nhóm 6b (bảng `book_*`, không bút toán kép, QĐ 1500). Mỗi sổ mới có bảng riêng, RLS, nhật ký kiểm toán, quyền `sohkd.*` có sẵn.

| Tác vụ | Nội dung | Kiểm thử trước |
|---|---|---|
| T1 | Migration 0291: `book_debt` (S4a), `book_fixed_asset` (S4b), `book_equity` (S4d), `book_other_asset` (mã 150 của B01) | `hkdBooks` mở rộng: tạo, RLS cách ly công ty, CHECK |
| T2 | Dịch vụ CRUD + zod (`hkdbooks/extras.ts`), route `/api/hkd/debts`, `/fixed-assets`, `/equity`, `/other-assets` | API 201/400/404, quyền |
| T3 | Dựng S4a, S4b, S4d (`hkdbooks/dnsnBooks.ts`), `built=true` trong `tt58.json` | số tính tay |
| T4 | Dựng B01-DNSN từ sổ, kèm kiểm tra 200 = 500 và ghi chú chênh lệch | số tính tay, chênh lệch được nêu |
| T5 | Chứng từ 01-TT, 02-TT, 01-VT, 02-VT in từ bút ghi sổ đơn (`hkdbooks/vouchers.ts`), nhập định nghĩa `vouchers` vào `tt58.json` | HTML đúng nhãn, thứ tự chữ ký |
| T6 | Cập nhật `status.json` (limits/missing/cổng `reports`), kiểm thử `coa-data`, `regimes.test.ts` | cổng đổi đúng |
| T7 | Trang web: tab Công nợ, TSCĐ, Vốn chủ sở hữu, Tài sản khác; chọn sổ mới; nút in phiếu; Playwright luồng chính | E2E |
| T8 | Tài liệu `docs/user/giai-doan-7-hkd-sieu-nho.md`, `docs/TIEP-THEO.md`, sổ quyết định | |

Kiểm thử chạy trên Postgres ở 127.0.0.1:5432 (`DATABASE_URL`, `DATABASE_ADMIN_URL` trỏ cụm này; DB tạm theo `docs/dev/kiem-thu.md`).
