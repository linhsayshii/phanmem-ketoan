import { createHash } from 'node:crypto';
import type { Config } from '../../../config.js';
import { AppError } from '../../../plugins/errors.js';
import { guardFile } from './guard.js';
import { anthropicRecognizer, httpRecognizer } from './remote.js';
import type { FileKind, InvoiceRecognizer, RecognizedInvoice } from './types.js';
import { xmlRecognizer } from './xml.js';

export * from './types.js';
export { guardFile } from './guard.js';

// Kiểm thử đặt bộ nhận diện giả lập thay cho cấu hình môi trường (null = bỏ).
let override: InvoiceRecognizer[] | null = null;
export const setRecognizerOverride = (r: InvoiceRecognizer[] | null): void => { override = r; };

export function recognizersFor(config: Pick<Config, 'RECOGNIZER_PROVIDER' | 'RECOGNIZER_URL' | 'RECOGNIZER_API_KEY' | 'RECOGNIZER_MODEL' | 'RECOGNIZER_TIMEOUT_MS'>): InvoiceRecognizer[] {
  if (override) return [xmlRecognizer, ...override];
  if (config.RECOGNIZER_PROVIDER === 'http') return [xmlRecognizer, httpRecognizer(config)];
  if (config.RECOGNIZER_PROVIDER === 'anthropic') return [xmlRecognizer, anthropicRecognizer(config)];
  return [xmlRecognizer];
}

export interface RecognizeOutcome { recognition: RecognizedInvoice | null; provider: string; external: boolean; kind: FileKind | null; sha256: string; error: AppError | null }

// Chặn tệp, chọn bộ nhận diện theo loại tệp, gọi. Bộ ngoài chỉ chạy khi công ty đã bật cài đặt VÀ người dùng chọn gửi ra ngoài ở lần này; thiếu một trong hai thì từ chối trước khi gửi byte nào.
// Không ném: lỗi trả trong outcome để nơi gọi ghi nhật ký rồi mới trả lỗi.
export async function recognizeFile(recognizers: InvoiceRecognizer[], file: { buffer: Buffer; fileName: string }, gate: { companyAllows: boolean; userChose: boolean }): Promise<RecognizeOutcome> {
  const sha256 = createHash('sha256').update(file.buffer).digest('hex');
  const fail = (error: AppError, provider = 'none', kind: FileKind | null = null): RecognizeOutcome => ({ recognition: null, provider, external: false, kind, sha256, error });
  let kind: FileKind;
  try { kind = guardFile(file.buffer, file.fileName); } catch (e) { return fail(e instanceof AppError ? e : new AppError('RECOGNIZE_REJECTED', 'Tệp bị từ chối', 400)); }
  const adapter = recognizers.find((r) => r.supports(kind));
  if (!adapter) return fail(new AppError('RECOGNIZER_DISABLED', 'Nhận diện ảnh và PDF chưa được cấu hình trên máy chủ (RECOGNIZER_PROVIDER đang tắt). Hóa đơn XML vẫn nhận diện được.', 409), 'none', kind);
  if (adapter.external && !(gate.companyAllows && gate.userChose))
    return fail(new AppError('RECOGNIZER_EXTERNAL_NOT_ALLOWED', gate.companyAllows ? 'Chưa chọn gửi tệp ra dịch vụ nhận diện bên ngoài cho lần này' : 'Công ty chưa bật gửi tệp ra dịch vụ nhận diện bên ngoài (Cài đặt trợ lý)', 409), adapter.id, kind);
  try {
    const recognition = await adapter.recognize({ buffer: file.buffer, fileName: file.fileName, kind });
    return { recognition, provider: adapter.id, external: adapter.external, kind, sha256, error: null };
  } catch (e) {
    const err = e instanceof AppError ? e : new AppError('RECOGNIZER_ERROR', e instanceof Error && e.name === 'TimeoutError' ? 'Dịch vụ nhận diện quá thời gian chờ' : 'Không nhận diện được tệp này', 502);
    return { recognition: null, provider: adapter.id, external: adapter.external, kind, sha256, error: err };
  }
}
