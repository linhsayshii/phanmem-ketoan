# Sao lưu và phục hồi dữ liệu

- Hệ thống tự sao lưu toàn bộ cơ sở dữ liệu mỗi ngày lúc 02:00 (giờ Việt Nam) vào thư mục sao lưu (`/backups` trong Docker, biến `BACKUP_DIR`), giữ 14 bản gần nhất (`BACKUP_KEEP`).
- Sao lưu ngay: Hệ thống → Thông tin công ty → thẻ "Sao lưu" → nút "Sao lưu ngay" (cần quyền "Sao lưu dữ liệu"). Danh sách bản sao lưu hiển thị tên, dung lượng, thời gian.
- Phục hồi (người quản trị hệ thống, dòng lệnh): `DATABASE_ADMIN_URL=... docker/restore.sh backups/ketoan_YYYYMMDDTHHMMSS.dump`. Lệnh ghi đè toàn bộ dữ liệu hiện có của mọi công ty trong cơ sở dữ liệu; dừng API và worker trước khi phục hồi.
- Phục hồi thử định kỳ: khuyến nghị mỗi quý phục hồi vào một cơ sở dữ liệu tạm (`createdb ketoan_test && DATABASE_ADMIN_URL=.../ketoan_test docker/restore.sh ...`) và mở bằng một bản API trỏ vào đó.
- Phiên bản công cụ: phục hồi phải dùng `pg_restore` cùng phiên bản với máy chủ (PostgreSQL 16). Máy có client cùng phiên bản dùng `docker/restore.sh` như trên. Trên máy phát triển có client 18, dùng `docker compose exec -T postgres pg_restore --clean --if-exists --no-owner -d ketoan -U postgres < backups/<file>.dump`. Lưu ý role `app_user` phải tồn tại trước khi phục hồi (được tạo bởi `docker/postgres/init/01-roles.sql`).
