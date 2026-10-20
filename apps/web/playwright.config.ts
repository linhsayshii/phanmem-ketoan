import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 60_000, retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list', // CI tải thư mục playwright-report khi lỗi
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173', locale: 'vi-VN', trace: 'retain-on-failure' },
  // E2E_BASE_URL: chạy với máy chủ có sẵn; không thì tự dựng API và web
  ...(process.env.E2E_BASE_URL ? {} : { webServer: [
    { command: 'pnpm -F @kt/api dev', port: 3000, reuseExistingServer: true, cwd: '../..' },
    { command: 'pnpm -F @kt/web dev', port: 5173, reuseExistingServer: true, cwd: '../..' },
  ] }),
});
