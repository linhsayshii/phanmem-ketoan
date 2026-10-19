# Phần mềm kế toán doanh nghiệp Việt Nam

Dự án xây dựng phần mềm kế toán đầy đủ chức năng cho doanh nghiệp Việt Nam (TT 99/2025, TT 133/2016, hóa đơn điện tử 2026). Trạng thái 2026-10-19: hoàn tất nghiên cứu thị trường và đặc tả thiết kế, chưa có mã.

## Tài liệu

| Tài liệu | Nội dung |
|---|---|
| `reports/Nghiệp vụ phần mềm kế toán.md` | Báo cáo nghiên cứu tổng hợp: nghiệp vụ cần có (Baseline/Differentiator/Niche), chế độ kế toán và tham số pháp lý 2026, bề mặt tích hợp, quyết định mô hình dữ liệu, khoảng trống |
| `research_notes/Nghiệp vụ phần mềm kế toán/misa.md` | MISA SME/AMIS: phân hệ, chứng từ, quy trình cuối kỳ, báo cáo, tích hợp, giá |
| `research_notes/Nghiệp vụ phần mềm kế toán/doi-thu-viet-nam.md` | Fast, Bravo, Effect, 1C, Smart Pro, ACMan, Simba, Asoft, Viindoo, 3TSoft, Cyber, Vacom, Sapo, KiotViet và SUNSOFT PRO (web) |
| `research_notes/Nghiệp vụ phần mềm kế toán/sunsoft-pro.md` | Phân tích trực tiếp SUNSOFT PRO (Access): menu, 86 loại chứng từ, mô hình dữ liệu, quy trình cuối kỳ, báo cáo, lịch sử 2011–2026, bài học |
| `research_notes/Nghiệp vụ phần mềm kế toán/ma-nguon-mo-quoc-te.md` | Odoo, ERPNext, Dolibarr, Tryton, Bigcapital, Formance, TigerBeetle, Beancount…: mô hình sổ cái, kho, TSCĐ, thuế, báo cáo, giấy phép |
| `research_notes/Nghiệp vụ phần mềm kế toán/ma-nguon-mo-viet-nam-va-tich-hop.md` | Odoo `l10n_vn`/Viindoo, dự án GitHub Việt Nam, API hóa đơn điện tử, XML QĐ 1450, HTKK, ngân hàng (SePay/Casso/VietinBank/BIDV), VietQR, ký số, BHXH |
| `research_notes/Nghiệp vụ phần mềm kế toán/phap-ly-viet-nam.md` | Luật Kế toán, TT 99/2025, TT 133, TT 58/2026, TT 152/2025, hóa đơn điện tử, GTGT/TNDN/TNCN/BHXH 2026, tờ khai, dữ liệu cá nhân |
| `research_notes/Nghiệp vụ phần mềm kế toán/thiet-ke-so-cai.md` | Mẫu hình thiết kế sổ cái kép: lược đồ, máy trạng thái sửa chứng từ, số dư theo kỳ, giá vốn, thuế, sai lầm thường gặp, PostgreSQL |
| `docs/superpowers/specs/2026-10-19-phan-mem-ke-toan-design.md` | **Đặc tả thiết kế** (chờ duyệt): giả định, hướng tiếp cận, kiến trúc, ngăn xếp, mô hình dữ liệu, quy tắc nghiệp vụ, danh sách phân hệ, tham số pháp lý, tích hợp, kiểm thử, rủi ro |
| `docs/superpowers/plans/2026-10-19-lo-trinh-thuc-hien.md` | **Lộ trình thực hiện** theo 8 giai đoạn với công việc, tiêu chí nghiệm thu, ước lượng |

## Bước tiếp theo

1. Duyệt đặc tả (giả định G1–G7, ngăn xếp công nghệ, hướng tiếp cận A).
2. Thu thập văn bản gốc và môi trường thử theo mục "Việc cần làm trước giai đoạn 0" của lộ trình.
3. Viết kế hoạch chi tiết từng tác vụ cho giai đoạn 0 và 1, rồi bắt đầu lập trình.
