import { chromium, type Browser } from 'playwright';

// Một trình duyệt dùng chung cho cả tiến trình; lưu Promise để hai lần gọi đồng thời không mở hai trình duyệt.
let browser: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  const p: Promise<Browser> = chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    .then((b) => { b.on('disconnected', () => { if (browser === p) browser = null; }); return b; }, (e) => { if (browser === p) browser = null; throw e; });
  return (browser = p);
}

// HTML có thể chứa chữ do người dùng nhập: tắt JavaScript và chặn mọi yêu cầu mạng (chỉ cho data:/about:) để không chạy mã hay gọi được địa chỉ nội bộ từ máy chủ API (SSRF).
export async function renderPdf(html: string, opts: { landscape?: boolean } = {}): Promise<Buffer> {
  const context = await (await getBrowser()).newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.route('**/*', (route) => (/^(data|about):/.test(route.request().url()) ? route.continue() : route.abort()));
    await page.setContent(html, { waitUntil: 'load' });
    return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, landscape: opts.landscape ?? false, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } }));
  } finally { await context.close(); }
}
export async function closePdfBrowser(): Promise<void> {
  const b = browser; browser = null;
  await (await b?.catch(() => null))?.close();
}
