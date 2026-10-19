#!/usr/bin/env bash
# Dùng: DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/ketoan docker/restore.sh backups/ketoan_20260101T020000.dump
set -euo pipefail
[ $# -eq 1 ] || { echo "Dùng: $0 <file.dump>"; exit 1; }
: "${DATABASE_ADMIN_URL:?Thiếu DATABASE_ADMIN_URL}"
safe_url=$(printf '%s' "$DATABASE_ADMIN_URL" | sed -E 's#://([^:]+):[^@]+@#://\1:***@#') # không in mật khẩu ra màn hình/log
echo "Phục hồi $1 vào $safe_url (ghi đè dữ liệu hiện có). Nhấn Enter để tiếp tục, Ctrl+C để hủy."; read -r
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_ADMIN_URL" "$1"
echo "Xong."
