-- GĐ5 Task 15: mã BIN NAPAS (6 số) của ngân hàng, dùng sinh mã VietQR.
ALTER TABLE bank ADD COLUMN napas_bin text NULL CHECK (napas_bin IS NULL OR napas_bin ~ '^\d{6}$');
