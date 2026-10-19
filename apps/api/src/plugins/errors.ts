import fp from 'fastify-plugin';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

interface PgError extends Error { code?: string; detail?: string; constraint?: string }

export default fp(async (app) => {
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Dữ liệu không hợp lệ', details: err.issues } });
    const e = err as PgError & { validation?: unknown; statusCode?: number };
    if (e.validation) return reply.status(400).send({ error: { code: 'VALIDATION', message: e.message } });
    if (e.code === 'P0001' && e.message.includes(':')) {
      const [code, ...rest] = e.message.split(':');
      return reply.status(409).send({ error: { code: code!.trim(), message: rest.join(':').trim() } });
    }
    if (e.code === '23505') return reply.status(409).send({ error: { code: 'DUPLICATE', message: `Trùng dữ liệu (${e.constraint ?? ''})` } });
    if (e.code === '23503') return reply.status(409).send({ error: { code: 'REFERENCED', message: 'Dữ liệu đang được tham chiếu' } });
    if (e.code === '42501') return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Không có quyền trên dữ liệu' } });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: 'HTTP', message: e.message } });
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Lỗi hệ thống' } });
  });
});
