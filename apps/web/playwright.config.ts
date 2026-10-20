import { defineConfig } from '@playwright/test';
// E2E_API_PORT / E2E_WEB_PORT: chạy bằng máy chủ riêng ở cổng khác khi cổng mặc định đang có tiến trình khác (mặc định 3000 và 5173).
const apiPort = process.env.E2E_API_PORT ?? '3000'; const webPort = process.env.E2E_WEB_PORT ?? '5173';
export default defineConfig({
  // workers: 1 — các spec dùng chung một người dùng và một công ty E2E (cùng danh sách phiếu, cùng năm tài chính): chạy song song làm chúng giẫm nhau và rớt giả.
  testDir: './e2e', timeout: 60_000, workers: 1, retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list', // CI tải thư mục playwright-report khi lỗi
  use: { baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${webPort}`, locale: 'vi-VN', trace: 'retain-on-failure' },
  // E2E_BASE_URL: chạy với máy chủ có sẵn; không thì tự dựng API và web
  ...(process.env.E2E_BASE_URL ? {} : { webServer: [
    { command: 'pnpm -F @kt/api dev', port: Number(apiPort), env: { PORT: apiPort, WEB_ORIGIN: `http://localhost:${webPort}` }, reuseExistingServer: !process.env.CI, cwd: '../..' },
    { command: 'pnpm -F @kt/web dev', port: Number(webPort), env: { WEB_PORT: webPort, API_URL: `http://localhost:${apiPort}` }, reuseExistingServer: !process.env.CI, cwd: '../..' },
  ] }),
});
