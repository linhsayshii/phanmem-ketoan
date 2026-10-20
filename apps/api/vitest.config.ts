import { configDefaults, defineConfig } from 'vitest/config';

// Kiểm thử bất biến (fast-check, chạy lâu) chỉ chạy ở job CI `invariants` hoặc khi đặt INVARIANTS=1; `pnpm test` thường bỏ qua thư mục này.
export default defineConfig({
  test: { testTimeout: 30_000, globalSetup: ['@kt/db/test-global-setup'], exclude: [...configDefaults.exclude, ...(process.env.INVARIANTS === '1' ? [] : ['test/invariants/**'])] },
});
