/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // WEB_PORT / API_URL: chỉ để chạy E2E ở cổng khác (playwright.config.ts); mặc định 5173 và http://localhost:3000.
  server: { port: Number(process.env.WEB_PORT ?? 5173), strictPort: !!process.env.WEB_PORT, proxy: { '/api': process.env.API_URL ?? 'http://localhost:3000' } },
  // include: e2e/*.spec.ts là kiểm thử Playwright, không phải Vitest
  // testTimeout phải lớn hơn asyncUtilTimeout (5 giây, vitest.setup.ts), nếu không findBy*/waitFor không kịp báo lỗi rõ trước khi test hết giờ.
  test: { testTimeout: 30_000, environment: 'jsdom', setupFiles: ['./vitest.setup.ts'], globals: false, include: ['test/**/*.test.{ts,tsx}'] },
});
