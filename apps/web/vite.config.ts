/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  // include: e2e/*.spec.ts là kiểm thử Playwright, không phải Vitest
  test: { environment: 'jsdom', setupFiles: ['./vitest.setup.ts'], globals: false, include: ['test/**/*.test.{ts,tsx}'] },
});
