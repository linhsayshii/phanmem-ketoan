import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { FormulaError, TaxError, type TaxErrorCode } from '@kt/domain';

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: unknown) { super(message); }
}

interface PgError extends Error { code?: string; detail?: string; constraint?: string }
// Ràng buộc CHECK giữa nhiều cột: nói rõ ô cần sửa thay cho thông báo chung.
const CHECK_MSG: Record<string, string> = {
  tax_code_exempt_method_check: 'Mã không chịu thuế phải chọn phương pháp "Không tính thuế"',
  tax_code_pit_check: 'Thuế TNCN khấu trừ tại nguồn phải dùng phương pháp khấu trừ và không chọn giá đã gồm thuế',
};

// Lỗi động cơ thuế: thông báo tiếng Việt do động cơ dựng sẵn. Mã thuế không có là 404; cấu hình phân bổ sai/thiếu là 409 (trạng thái danh mục, không phải lỗi đầu vào); còn lại là lỗi đầu vào.
const TAX_STATUS: Record<TaxErrorCode, number> = {
  TAX_CODE_UNKNOWN: 404, TAX_DISTRIBUTION_MISSING: 409, TAX_DISTRIBUTION_INVALID: 409,
  TAX_DECLARED_MISMATCH: 400, TAX_RATE_MISSING: 400, TAX_CODE_DUPLICATE: 400, TAX_FX_RATE_REQUIRED: 400, INVOICE_ROUNDING_OVERFLOW: 400,
};

export default fp(async (app) => {
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details !== undefined && { details: err.details }) } });
    if (err instanceof TaxError) return reply.status(TAX_STATUS[err.code]).send({ error: { code: err.code, message: err.message } });
    if (err instanceof FormulaError) return reply.status(400).send({ error: { code: 'FORMULA_INVALID', message: err.message } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Dữ liệu không hợp lệ', details: err.issues } });
    const e = err as PgError & { validation?: unknown; statusCode?: number };
    if (e.validation) return reply.status(400).send({ error: { code: 'VALIDATION', message: e.message } });
    if (e.code === 'P0001' && e.message.includes(':')) {
      const [code, ...rest] = e.message.split(':');
      // Quy ước: mã *_NOT_FOUND là đối tượng không tồn tại/không thấy được (404); trạng thái không cho thao tác là 409.
      return reply.status(code!.trim().endsWith('_NOT_FOUND') ? 404 : 409).send({ error: { code: code!.trim(), message: rest.join(':').trim() } });
    }
    // SQLSTATE lớp 22 (dữ liệu sai: tràn số, sai định dạng...), 23502 (NOT NULL) và 23514 (CHECK) là lỗi đầu vào, không phải lỗi hệ thống.
    if (e.code?.startsWith('22') || e.code === '23502' || e.code === '23514') return reply.status(400).send({ error: { code: 'VALIDATION', message: (e.code === '23514' && CHECK_MSG[e.constraint ?? '']) || 'Dữ liệu không hợp lệ' } });
    // Bế tắc (40P01) và lỗi tuần tự hóa (40001): PostgreSQL đã hủy giao dịch này, chưa ghi gì; người dùng thử lại được.
    if (e.code === '40P01' || e.code === '40001') return reply.status(409).send({ error: { code: 'CONCURRENT_RETRY', message: 'Thao tác đồng thời bị xung đột, hãy thử lại' } });
    // Không đưa tên ràng buộc ra ngoài; ràng buộc duy nhất của danh mục đều có `code` trong tên.
    if (e.code === '23505') return reply.status(409).send({ error: { code: 'DUPLICATE', message: /_code_key$/.test(e.constraint ?? '') ? 'Mã đã tồn tại' : 'Trùng dữ liệu đã có' } });
    if (e.code === '23503') return reply.status(409).send({ error: { code: 'REFERENCED', message: 'Dữ liệu đang được tham chiếu' } });
    if (e.code === '42501') return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Không có quyền trên dữ liệu' } });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: 'HTTP', message: e.message } });
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Lỗi hệ thống' } });
  });
});
