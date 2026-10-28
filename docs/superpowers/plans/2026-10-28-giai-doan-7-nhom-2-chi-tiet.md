# GĐ7 nhóm 2: báo cáo song ngữ Việt–Anh (kế hoạch chi tiết)

Migration 0210; quyết định 1050–1099; cổng E2E API 3020, web 5182, DB `ketoan_gd7_2`.

## Phạm vi
Tên tiếng Anh của tài khoản (`account.name_en`, có từ 0001) và chỉ tiêu báo cáo (`report_line.label_en`), cột `translation_status` ('draft' | 'reviewed', không phải dữ liệu pháp lý); màn hình sửa tay; nạp tên cho mẫu hệ thống (`packages/coa-data/data/i18n`); tham số `lang=vi|en|vi-en` cho bản in Bảng cân đối số phát sinh, Sổ Cái, Sổ chi tiết, Nhật ký chung, B01/B02/B03 và bộ sổ năm. JSON mặc định không đổi.

## Tác vụ (kiểm thử trước)
1. Migration 0210: cột `account.translation_status`, `report_line.label_en` + `translation_status`, `report_template.label_en`, trigger `fn_translation_status` (có bản dịch mà chưa nêu trạng thái thì là draft; không có bản dịch thì NULL). Kiểm: `apps/api/test/songNgu.test.ts`.
2. Dữ liệu mẫu: `data/i18n/account-names-en.json` (chỉ số hiệu cấp 1 dịch chắc chắn, khóa `REGIME:code` ghi đè theo chế độ) và `report-labels-en.json` (khóa là nhãn bỏ số thứ tự); `load.ts` điền khi CSV chưa có; `reference.ts` đồng bộ `report_template.label_en`; `copyReportTemplates` chép sang công ty.
3. `saveReportDef` giữ `label_en` theo mã dòng khi màn hình công thức không gửi.
4. Từ điển nhãn một nơi: `reporting/print/i18n.ts` (`EN`, `tr`, `localizeDoc`); `packages/domain/src/printLang.ts` (kiểu và nhãn ngôn ngữ cho web). `localizeDoc` dịch tài liệu đã dựng bằng tiếng Việt (nhãn cột, tiêu đề, kỳ, dòng tổng hợp, chữ ký, tên tài khoản/chỉ tiêu từ DB) nên các hàm dựng sổ (`bookSet.ts`) không đổi.
5. Route: `lang` ở năm đường in và `/api/print/book-set`; `modules/translations/routes.ts` (xem, sửa hàng loạt, điền chỗ trống từ mẫu), dùng quyền `account.*` và `report_def.*` có sẵn.
6. Web: `PrintLangSelect` ở Sổ sách, Báo cáo tài chính, hộp thoại bộ sổ năm; trang `Tên tiếng Anh` (`/he-thong/ten-tieng-anh`); `e2e/song-ngu.spec.ts`.
7. Tài liệu `docs/user/giai-doan-7-song-ngu.md`, quyết định 1050–1056.

## Kiểm tra cuối
`pnpm lint && pnpm typecheck`; `pnpm -F @kt/api test -- test/songNgu.test.ts test/print.test.ts test/ledgers.test.ts test/coa.test.ts`; `pnpm -F @kt/coa-data test`; Playwright `song-ngu.spec.ts`, `in-so.spec.ts`.
