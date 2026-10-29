import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

// Đăng nhập bằng API (để có năm tài chính) rồi bằng giao diện (để trang có phiên)
async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

type Saved = { accountCode: string; partyCode: string | null; bankAccountNo: string | null; docNo: string | null; docDate: string | null; dueDate: string | null; currencyCode: string; debit: string; credit: string; debitCurrency: string; creditCurrency: string };
const toBody = (r: Saved) => ({ accountCode: r.accountCode, partyCode: r.partyCode, bankAccountNo: r.bankAccountNo, docNo: r.docNo, docDate: r.docDate, dueDate: r.dueDate, currencyCode: r.currencyCode, debit: r.debit, credit: r.credit, debitCurrency: r.debitCurrency, creditCurrency: r.creditCurrency });

test('Số dư đầu kỳ: nhập bằng bàn phím, ô TK ngân hàng chỉ dừng ở dòng tiền gửi, ô chứng từ và hạn chỉ dừng ở dòng công nợ; lưu kèm tài khoản ngân hàng và hóa đơn', async ({ page, request }) => {
  await signIn(page, request);
  const stamp = Date.now(); const accountNo = `99${String(stamp).slice(-9)}`;
  // Tài khoản ngân hàng riêng của lần chạy (ngân hàng VCB dùng chung giữa các lần: đã có thì bỏ qua lỗi trùng)
  await request.post('/api/catalogs/bank', { data: { code: 'VCB', name: 'Vietcombank' } });
  const created = await request.post('/api/catalogs/bank_account', { data: { bank_code: 'VCB', account_no: accountNo, account_name: `E2E ${stamp}`, gl_account_code: '1121' } });
  expect(created.ok(), await created.text()).toBeTruthy();
  await request.post('/api/catalogs/party', { data: { code: 'KHE2E', name: 'Khách hàng E2E', is_customer: true } }); // dùng chung giữa các lần chạy: đã có thì bỏ qua lỗi trùng
  // Số dư của năm 2026 dùng chung với công ty E2E: lưu bản cũ, thay bằng bảng trống để lưới chỉ có dòng nhập mới, trả lại bản cũ ở cuối.
  const original = await (await request.get('/api/opening-balance/2026')).json() as Saved[];
  expect((await request.put('/api/opening-balance/2026', { data: { rows: [] } })).ok()).toBeTruthy();
  try {
    await page.goto('/so-cai/so-du-dau-ky');
    await expect(page.getByRole('heading', { level: 1, name: 'Số dư đầu kỳ' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lưu' })).toBeEnabled();
    await expect(page.locator('.ag-center-cols-container .ag-row')).toHaveCount(1); // chỉ còn dòng trống cuối (dòng cũ của lần nạp trước đã gỡ khỏi lưới)
    const cell = (row: number, col: string) => page.locator(`.ag-center-cols-container .ag-row[row-index="${row}"] [col-id="${col}"]`);
    // ô đang có trình soạn (tiêu điểm nằm trong ô): col-id của ô đó
    // chỉ tính khi tiêu điểm đã vào ô nhập của trình soạn: ô vừa được chọn (div) có tiêu điểm trước, gõ lúc đó thì phím rơi mất
    const editingCol = () => page.evaluate(() => (document.activeElement instanceof HTMLInputElement ? document.activeElement.closest('.ag-cell')?.getAttribute('col-id') ?? null : null));
    const type = async (text: string) => { await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(text); };

    // Dòng 1: 1121 (tiền gửi). Enter đi qua Đối tượng rồi dừng ở TK ngân hàng, nhập số tài khoản, đi tiếp qua Loại tiền tới Dư Nợ
    await cell(0, 'accountCode').click(); await type('1121'); await page.keyboard.press('Enter');
    await expect.poll(editingCol).toBe('partyCode'); await page.keyboard.press('Enter');
    await expect.poll(editingCol).toBe('bankAccountNo'); await page.keyboard.type(accountNo); await page.keyboard.press('Enter');
    for (const col of ['projectCode', 'contractCode', 'currencyCode']) { await expect.poll(editingCol).toBe(col); await page.keyboard.press('Enter'); } // Vụ việc, Hợp đồng (Task 13c)
    await expect.poll(editingCol).toBe('debit'); await type('5000000'); await page.keyboard.press('Tab');
    await expect.poll(editingCol).toBe('credit'); // Tab giống Enter
    for (const col of ['debitCurrency', 'creditCurrency', 'accountCode']) { await page.keyboard.press('Enter'); await expect.poll(editingCol).toBe(col); } // Enter ở ô cuối thêm dòng mới

    // Dòng 2: 1111 (tiền mặt, không theo dõi ngân hàng). Đối tượng rồi nhảy thẳng sang Loại tiền, không dừng ở ô TK ngân hàng
    await expect(cell(1, 'accountCode')).toBeVisible(); await type('1111'); await page.keyboard.press('Enter');
    await expect.poll(editingCol).toBe('partyCode'); await page.keyboard.press('Enter');
    for (const col of ['projectCode', 'contractCode', 'currencyCode']) { await expect.poll(editingCol).toBe(col); await page.keyboard.press('Enter'); } // Vụ việc, Hợp đồng (Task 13c)
    await expect.poll(editingCol).toBe('debit'); await type('1000000'); await page.keyboard.press('Enter');
    await expect.poll(editingCol).toBe('credit');
    for (const col of ['debitCurrency', 'creditCurrency', 'accountCode']) { await page.keyboard.press('Enter'); await expect.poll(editingCol).toBe(col); }

    // Dòng 3: 131 (công nợ phải thu) theo hóa đơn. Bỏ qua ô TK ngân hàng, dừng ở Số chứng từ, Ngày chứng từ, Hạn thanh toán (gõ dd/mm/yyyy)
    await expect(cell(2, 'accountCode')).toBeVisible(); await type('131'); await page.keyboard.press('Enter');
    await expect.poll(editingCol).toBe('partyCode'); await page.keyboard.type('KHE2E'); await page.keyboard.press('Enter');
    await expect.poll(editingCol).toBe('docNo'); await page.keyboard.type('HD-E2E-1'); await page.keyboard.press('Enter');
    await expect.poll(editingCol).toBe('docDate'); await page.keyboard.type('15/12/2025'); await page.keyboard.press('Enter');
    await expect.poll(editingCol).toBe('dueDate'); await page.keyboard.type('15/01/2026'); await page.keyboard.press('Enter');
    for (const col of ['projectCode', 'contractCode', 'currencyCode']) { await expect.poll(editingCol).toBe(col); await page.keyboard.press('Enter'); } // Vụ việc, Hợp đồng (Task 13c)
    await expect.poll(editingCol).toBe('debit'); await type('2000000'); await page.keyboard.press('Enter');
    await expect.poll(editingCol).toBe('credit'); await page.keyboard.press('Escape');
    await expect(cell(2, 'docDate')).toHaveText('15/12/2025');

    await page.getByRole('button', { name: 'Lưu' }).click();
    await expect(page.locator('.ant-message').getByText('Đã lưu')).toBeVisible();
    const rows = await (await request.get('/api/opening-balance/2026')).json() as (Saved & { bankName: string | null })[];
    expect(rows.map((r) => [r.accountCode, r.bankAccountNo, r.debit])).toEqual([['1111', null, '1000000'], ['1121', accountNo, '5000000'], ['131', null, '2000000']]);
    expect(rows.find((r) => r.accountCode === '131')).toMatchObject({ partyCode: 'KHE2E', docNo: 'HD-E2E-1', docDate: '2025-12-15', dueDate: '2026-01-15' });
    expect(rows.find((r) => r.accountCode === '1121')!.bankName).toBe('Vietcombank');
    // Số dư 1121 đã gán tài khoản ngân hàng nên không còn cảnh báo thiếu tài khoản ngân hàng cho 1121
    const issues = await (await request.get('/api/opening-balance/2026/check')).json() as { code: string; accountCode?: string }[];
    expect(issues.filter((i) => i.code === 'BANK_ACCOUNT_MISSING')).toEqual([]);
  } finally {
    await request.put('/api/opening-balance/2026', { data: { rows: original.map(toBody) } });
  }
});
