-- Lưu băm SHA-256 của mã phiên thay vì mã thô (lộ DB không lộ phiên đang dùng).
-- Mọi phiên hiện có bị xóa: mọi người dùng phải đăng nhập lại.
DELETE FROM user_session;
ALTER TABLE user_session ADD COLUMN token_hash text NOT NULL;
CREATE UNIQUE INDEX user_session_token_hash ON user_session (token_hash);
CREATE INDEX user_session_expires ON user_session (expires_at);
