# Quyết định khi thực hiện GĐ7

Mỗi nhóm ghi vào mục của mình (dải số riêng). Khuôn: "số. quyết định — lý do — giá phải trả nếu sai. (tác vụ)".

## Nhóm 2: báo cáo song ngữ (1050–1099)

1050. Số giữ định dạng Việt ở mọi ngôn ngữ (1.234.567, ngày dd/mm/yyyy) — sổ nộp cơ quan Việt Nam và Excel đã theo ô số; đổi dấu theo ngôn ngữ làm lệch đối chiếu với màn hình — người đọc nước ngoài phải quen dấu chấm hàng nghìn. (4)
1051. `translation_status` ('draft' | 'reviewed') là cờ dịch thuật, không phải dữ liệu pháp lý; mọi bản in có `lang` khác `vi` đều ghi "Bản dịch tham khảo, không phải bản dịch chính thức" — tránh hiểu nhầm bản dịch là văn bản chính thức — dòng chú thích chiếm một dòng cuối bảng. (1, 4)
1052. Trạng thái do trigger `fn_translation_status` đặt: có bản dịch mà chưa nêu trạng thái là 'draft', xóa bản dịch thì về NULL; sửa chữ không tự hạ 'reviewed' về 'draft' — mọi đường ghi (PATCH tài khoản cũ, nạp mẫu, màn hình mới) nhất quán mà không sửa từng chỗ ghi — người sửa chữ qua đường cũ phải tự đặt lại trạng thái. (1)
1053. Dịch ở lớp sau (`localizeDoc`) trên tài liệu đã dựng tiếng Việt, nhận loại sổ qua khóa cột — hàm dựng sổ (`bookSet.ts`) do nhóm 1 cũng sửa nên không đụng, hợp nhất dễ — đổi tên khóa cột ở nhóm khác sẽ làm bản dịch rơi về tiếng Việt (kiểm thử `inferKind` bắt). (4)
1054. Từ điển nhãn là một bảng `EN` khóa theo câu tiếng Việt đúng như builder in ra; câu không có thì rơi về tiếng Việt, không báo lỗi — thiếu bản dịch không được làm hỏng bản in — nhãn mới thêm ở sổ sau phải nhớ thêm vào bảng. (4)
1055. Tên tiếng Anh mẫu hệ thống chỉ nạp cho tài khoản cấp 1 và chỉ tiêu có thuật ngữ chuẩn, đều ghi 'draft'; phần chưa chắc để trống (bản in rơi về tiếng Việt). Tên theo chế độ ghi đè bằng khóa `TT99:112` — không đoán nghĩa tài khoản chi tiết — bản in song ngữ còn nhiều tên Việt xen lẫn, kế toán nhập tay tiếp. (2)
1056. `saveReportDef` (xóa rồi chèn lại dòng) giữ `label_en` và trạng thái theo mã dòng khi đầu vào không có `labelEn`; có `labelEn` (kể cả null) thì ghi theo đầu vào — màn hình công thức không biết tiếng Anh nên không được làm mất bản dịch — đổi mã dòng ở màn hình công thức làm mất bản dịch của dòng đó. (3)
1057. `fill-from-template` chỉ điền ô trống, không ghi đè; công ty mới đã nhận tên khi tạo tài khoản/nạp mẫu nên lệnh chủ yếu dành cho công ty có từ trước — tránh mất tên đã sửa tay — mẫu hệ thống cập nhật sau không tự lan vào công ty. (5)
1058. Dùng quyền có sẵn `account.view/update` và `report_def.view/update` cho trang Tên tiếng Anh, không thêm quyền mới — tên tiếng Anh là thuộc tính của danh mục đó — không tách riêng được quyền chỉ dịch. (5)
1059. JSON của các báo cáo không đổi và không thêm trường tiếng Anh (`lang` chỉ ảnh hưởng bản in); trường bổ sung tùy chọn để sau — giữ hợp đồng API cho màn hình và tích hợp — lưới trên màn hình chưa hiện tên tiếng Anh. (5)
