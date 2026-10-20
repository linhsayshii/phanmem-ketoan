import { defineConfig } from 'vitest/config';

export default defineConfig({
  // máy 2 CPU (VPS, CI) dựng thành phần antd chậm: 5 giây mặc định hay rớt giả
  test: { testTimeout: 30_000, environment: 'jsdom', setupFiles: ['./vitest.setup.ts'], globals: false },
});
