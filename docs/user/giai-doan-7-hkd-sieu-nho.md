# Giai đoạn 7: Chế độ kế toán hộ kinh doanh và doanh nghiệp siêu nhỏ

Phần mềm đã có chỗ cho hai chế độ kế toán mới: Thông tư 152/2025/TT-BTC (hộ kinh doanh, cá nhân kinh doanh, hiệu lực 01/01/2026) và Thông tư 58/2026/TT-BTC (doanh nghiệp siêu nhỏ, hiệu lực 01/07/2026, thay Thông tư 132/2018/TT-BTC). Hai chế độ này **chưa dùng được cho kế toán thật**: phần mềm chưa có văn bản gốc nên chưa có sổ, báo cáo hay tờ khai của chúng. Phần mềm không tự điền các mẫu sổ, chỉ tiêu hay tỷ lệ thuế từ bài viết thứ cấp.

## Xem tình trạng các chế độ

Menu **Hệ thống > Chế độ kế toán** liệt kê TT 99/2025, TT 133/2016, TT 200/2014 (dùng được) và TT 152/2025, TT 58/2026 (chưa dùng cho kế toán thật). Bấm mũi tên đầu dòng của chế độ chưa sẵn sàng để xem:

- Phần nào còn chờ văn bản gốc: hệ thống tài khoản, mẫu sổ, báo cáo tài chính.
- **Văn bản cần cung cấp**: số hiệu, phụ lục, mẫu cần có.
- Danh mục tên sổ theo nguồn thứ cấp (ví dụ S1a-HKD, S2c-HKD, S1-DNSN), có nhãn chưa đối chiếu văn bản gốc; chưa in được.
- Nguồn đã tham khảo.

## Tạo công ty và năm tài chính

Ở màn **Tạo công ty mới**, danh sách Chế độ kế toán có hai mục ghi "chờ văn bản gốc". Chọn một trong hai sẽ hiện cảnh báo "Chưa có văn bản gốc, chưa dùng cho kế toán thật", và bước Hoàn tất bị từ chối (mẫu hệ thống tài khoản chưa có dữ liệu), không để lại năm tài chính nào. Hộ kinh doanh và doanh nghiệp siêu nhỏ vẫn có thể dùng phần mềm theo TT 133/2016 hoặc TT 99/2025 (doanh nghiệp siêu nhỏ được chọn các chế độ này theo quy định hiện hành; hộ kinh doanh xin ý kiến kế toán về lựa chọn chế độ).

## Khi nào dùng được

Khi người dùng cung cấp văn bản gốc (danh sách ở mục "GĐ7 nhóm 6 — Chờ người dùng" trong `docs/TIEP-THEO.md`), phần mềm sẽ nhập sổ S1a, S2a, S2b đến S2e, S3a-HKD, sổ S1 đến S4-DNSN, báo cáo B01-DNSN, B02-DNSN và tờ khai 01/CNKD, đối chiếu với số liệu tính tay rồi mới mở chế độ cho kế toán thật.
