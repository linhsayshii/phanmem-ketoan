import { defineConfig } from 'vitest/config';

// Máy chủ DB có lúc bận (dữ liệu kiểm thử tích lũy trong DB phát triển): 5 giây mặc định làm rớt giả. Kiểm thử cần lâu hơn tự đặt mức riêng.
export default defineConfig({ test: { testTimeout: 30_000, globalSetup: ['@kt/db/test-global-setup'] } });
