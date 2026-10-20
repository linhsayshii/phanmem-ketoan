import { chromium, type Browser } from 'playwright';
import { AppError } from '../../../plugins/errors.js';

// Một trình duyệt dùng chung cho cả tiến trình; lưu Promise để hai lần gọi đồng thời không mở hai trình duyệt.
let browser: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  const p: Promise<Browser> = chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    .then((b) => { b.on('disconnected', () => { if (browser === p) browser = null; }); return b; }, (e) => { if (browser === p) browser = null; throw e; });
  return (browser = p);
}

// Semaphore nhỏ: tối đa `max` tác vụ chạy cùng lúc, còn lại xếp hàng theo thứ tự đến; tác vụ lỗi vẫn trả chỗ.
export function limitConcurrency(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0; const waiting: (() => void)[] = [];
  return async (task) => {
    if (running >= max) await new Promise<void>((ok) => waiting.push(ok)); else running++; // chỗ được trao thẳng cho người chờ nên `running` không đổi
    try { return await task(); } finally { const next = waiting.shift(); if (next) next(); else running--; }
  };
}
// Mỗi lần dựng PDF mở một ngữ cảnh Chromium riêng, nặng bộ nhớ: tối đa 2 lần cùng lúc trong một tiến trình.
const pdfSlot = limitConcurrency(2);

// HTML có thể chứa chữ do người dùng nhập: tắt JavaScript và chặn mọi yêu cầu mạng (chỉ cho data:/about:) để không chạy mã hay gọi được địa chỉ nội bộ từ máy chủ API (SSRF).
export const renderPdf = (html: string, opts: { landscape?: boolean } = {}): Promise<Buffer> => pdfSlot(async () => {
  try {
    const context = await (await getBrowser()).newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => (/^(data|about):/.test(route.request().url()) ? route.continue() : route.abort()));
      await page.setContent(html, { waitUntil: 'load' });
      return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, landscape: opts.landscape ?? false, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } }));
    } finally { await context.close(); }
  } catch (e) {
    console.error('renderPdf', e); // chi tiết lỗi Chromium chỉ ghi nhật ký, người dùng nhận thông báo chung
    throw new AppError('PDF_RENDER_FAILED', 'Không tạo được tệp PDF; hãy thử in theo từng phần hoặc xuất Excel', 500);
  }
});
export async function closePdfBrowser(): Promise<void> {
  const b = browser; browser = null;
  await (await b?.catch(() => null))?.close();
}
