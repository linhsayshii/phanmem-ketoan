# Sổ quyết định GĐ7 (2026-10-28 → …)

Kế hoạch: `2026-10-28-giai-doan-7-chi-tiet.md`. Số bắt đầu từ 1000 (GĐ6 dùng 599+). Mỗi nhóm chỉ sửa mục của mình. Mỗi dòng: quyết định — lý do — giá phải trả nếu sai. Cuối dòng: tác vụ/mã commit.

## Chung (1300+)

1300. Nhánh `claude/gd7-mo-rong` từ `main`, không push `main`; migration từ 0200 vì `migrate.ts` sắp tên và áp dụng tệp chưa có, chịu được khoảng trống — khi hợp nhất với GĐ6 không cần đánh lại số; nếu hàm/trigger cùng tên bị định nghĩa lại ở cả hai nhánh thì phải viết migration hòa giải. (chung)

## Nhóm 1 — Hình thức sổ (1000–1049)

1000. `book_form` lưu ở bảng mới `fiscal_year_setting(tenant_id, fiscal_year, book_form)` thay vì cột `fiscal_year.book_form` — repo không có bảng `fiscal_year` (năm là tập hàng `fiscal_period`); thêm cột vào `fiscal_period` sẽ lặp 13 lần mỗi năm và buộc sửa migration đóng băng/hàm kỳ — nếu sau này có bảng năm thì chuyển cột bằng một migration. Không có hàng = `NKC`. (migration 0200)
1001. Quyền đổi hình thức sổ = `period.update` (quyền sửa kỳ kế toán hiện có), không thêm quyền mới — "quyền như sửa năm tài chính" — người chỉ có `period.update` nhưng không xem sổ vẫn đổi được cờ (cờ không chứa số liệu). (bookFormRoutes.ts)
1002. Đổi `book_form` chỉ ghi `fiscal_year_setting` (có `audit_event` qua trigger), không ghi voucher/dòng sổ/số dư; chỉ ảnh hưởng `bookSetDocs` (In cả bộ sổ năm) và trang Hình thức sổ; các trang Sổ sách kế toán, Sổ quỹ, báo cáo tài chính vẫn như cũ — tránh đổi hành vi báo cáo đang dùng — người dùng phải vào trang Hình thức sổ để xem sổ theo hình thức. (bookSet.ts)
1003. Chứng từ ghi sổ (`ledger_voucher_set`, `ledger_voucher_set_item`) chỉ là dấu nhóm các chứng từ đã ghi sổ (`posted`/`reversed`) trong khoảng ngày của một năm; mỗi chứng từ gốc vào tối đa một nhóm (`UNIQUE (tenant_id, voucher_id)`); số hiệu = max+1 theo năm dưới khóa tư vấn; lập lại chỉ gom chứng từ chưa vào nhóm nào, không có chứng từ thì 409 `NO_VOUCHERS` — đúng nghiệp vụ "số hiệu, ngày" mà không tạo voucher giả — xóa nhóm để số hiệu thủng (không đánh lại số). (bookForms.ts)
1004. Chứng từ gốc bỏ ghi sổ (`unpost`) vẫn nằm trong nhóm nhưng mọi báo cáo lọc `state IN ('posted','reversed')` nên không hiện; nhóm không bị tự cập nhật — đơn giản, số liệu sổ luôn đúng theo sổ cái — số tiền/số chứng từ của nhóm đổi theo, in lại sẽ khác bản đã in. (bookForms.ts)
1005. Số mẫu: chỉ S02a/S02b/S02c1-DN cho TT99 và TT200 (theo yêu cầu nghiệp vụ nhóm), CHƯA đối chiếu văn bản gốc (`~/legal-docs` không có tt99/tt200 trong môi trường này); TT133 không có mục nên sổ in không có dòng "Mẫu số". Nhật ký – Sổ Cái và Nhật ký – Chứng từ không có số mẫu: yêu cầu ghi S06-DN nhưng `S06` đang là Bảng cân đối số phát sinh trong `forms.ts`, hai mã mâu thuẫn nên không đoán — không bịa dữ liệu pháp lý — in thiếu số mẫu cho đến khi đối chiếu văn bản; ghi "Chờ người dùng". (forms.ts)
1006. Nhật ký – Sổ Cái dựng từ các dòng của Nhật ký chung (cùng truy vấn `generalJournal`) kèm cộng phát sinh theo từng tài khoản; không chia cột theo tài khoản như mẫu giấy (số tài khoản động, không đoán bố cục) — tổng Nợ = tổng Có và khớp Bảng cân đối số phát sinh được đảm bảo vì cùng nguồn — mẫu in không giống hệt sổ giấy. (bookForms.ts nksc)
1007. Nhật ký – Chứng từ: bảng kê chung theo bên Có của một tài khoản (hoặc mọi tài khoản có phát sinh Có khi in bộ sổ), mỗi cột là một tài khoản Nợ đối ứng, dựng từ `voucher_pair`; không chia theo mẫu S07–S10-DN từng tài khoản vì không chắc các cột mẫu — giao diện ghi rõ — tổng bảng kê = tổng phát sinh Có của tài khoản đó (kiểm thử đối chiếu Sổ Cái). (bookForms.ts nkct)
1008. Sổ Cái theo CTGS (S02c1) chỉ gồm chứng từ đã vào nhóm, dòng ghi theo ngày/số hiệu CTGS; số dư đầu lấy từ sổ cái đầy đủ; trả `unassigned` (số chứng từ trong kỳ chưa vào nhóm) và hiện cảnh báo trên màn hình/bản in thay vì chặn — tránh bắt người dùng lập nhóm mới xem được sổ — nếu còn chứng từ chưa vào nhóm thì tổng phát sinh nhỏ hơn Bảng cân đối số phát sinh đúng phần đó. (bookForms.ts ctgsLedger)
1009. Mọi sổ hình thức (JSON, in, chi tiết Chứng từ ghi sổ) chặn bằng `assertAllSensitive` như Nhật ký chung vì chứa công nợ và giá vốn; xem danh sách/lập/xóa nhóm theo quyền `voucher_set.*` (không lộ số liệu theo tài khoản) — chặn ở API — người có `voucher_set.view` nhưng thiếu cờ vẫn thấy số tiền tổng từng nhóm trong danh sách. (bookFormRoutes.ts)
1010. Kiểm thử bất biến của nhóm nằm trong `apps/api/test/bookForms.test.ts` (không dùng fast-check): tổng Nợ = tổng Có, khớp Bảng cân đối số phát sinh theo từng tài khoản, đổi `book_form` không đổi số đếm voucher/dòng/cặp và Bảng cân đối số phát sinh — dữ liệu nhỏ cố định đủ chứng minh tính chất vì sổ dùng chung truy vấn — chưa có thuộc tính ngẫu nhiên. PDF của Chromium chạy được khi `PLAYWRIGHT_BROWSERS_PATH` trỏ tới bản có sẵn (máy này có bản 1243, Playwright cần 1248: tạo thư mục liên kết). (test)

## Nhóm 2 — Song ngữ (1050–1099)

## Nhóm 3 — Ngân sách và phân tích (1100–1149)

## Nhóm 4 — Phê duyệt và mobile (1150–1199)

## Nhóm 5 — Đa chi nhánh (1200–1249)

## Nhóm 6 — HKD và siêu nhỏ (1250–1299)
