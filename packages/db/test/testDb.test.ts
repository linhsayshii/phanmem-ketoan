import { expect, it } from 'vitest';

it('kiểm thử chạy trên DB tạm của lần chạy, không phải DB phát triển', () => {
  expect(new URL(process.env.DATABASE_URL!).pathname).toMatch(/^\/ketoan_t_[0-9a-f]{8}$/);
  expect(new URL(process.env.DATABASE_ADMIN_URL!).pathname).toBe(new URL(process.env.DATABASE_URL!).pathname);
});
