-- Chỉ mục phục vụ đếm lần đăng nhập sai theo tên và theo IP (giới hạn đăng nhập)
CREATE INDEX login_event_username_ts ON login_event (username, ts DESC);
CREATE INDEX login_event_ip_ts ON login_event (ip, ts DESC);
