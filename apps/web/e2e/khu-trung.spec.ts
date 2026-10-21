import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

test('Khử trùng chứng từ: thấy cặp PC và BN, đánh dấu không trùng, đảo chứng từ trùng', async ({ page, request }) => {
  await signIn(page, request);
  // Dữ liệu E2E dùng chung: mỗi lần một khách hàng và một số tiền riêng; chỉ xét cặp của khách hàng đó. Ngày cố định 5 và 7/11/2026.
  const stamp = Date.now(); const code = `KHTR${stamp}`; const amount = String(10_000_000 + (stamp % 9_000_000));
  expect((await request.post('/api/catalogs/party', { data: { code, name: `Nhà cung cấp trùng ${stamp}`, is_vendor: true } })).ok()).toBeTruthy();
  const bank = await request.post('/api/catalogs/bank', { data: { code: 'VCBE2E', name: 'Vietcombank E2E' } });
  expect([201, 409], await bank.text()).toContain(bank.status());
  const acc = await request.post('/api/catalogs/bank_account', { data: { bank_code: 'VCBE2E', account_no: '0099001', gl_account_code: '1121' } });
  expect([201, 409], await acc.text()).toContain(acc.status());
  const mk = async (voucherType: 'PC' | 'BN', date: string) => {
    const r = await request.post('/api/vouchers', { data: { voucherType, postingDate: date, documentDate: date, description: `Trả tiền ${stamp}`, partyCode: code, autoPost: true,
      ...(voucherType === 'BN' ? { bankAccountNo: '0099001' } : {}),
      lines: [{ accountCode: '331', partyCode: code, debit: amount, credit: '0' }, { accountCode: voucherType === 'PC' ? '1111' : '1121', debit: '0', credit: amount }] } });
    expect(r.ok(), await r.text()).toBeTruthy(); return (await r.json()) as { id: string; voucherNo: string };
  };
  const pc = await mk('PC', '2026-11-05'); const bn = await mk('BN', '2026-11-07');
  // Cặp thứ hai cùng khách hàng, số tiền khác: dùng để thử "Không trùng"
  const amount2 = String(Number(amount) + 1);
  const mk2 = async (voucherType: 'PC' | 'BN', date: string) => {
    const r = await request.post('/api/vouchers', { data: { voucherType, postingDate: date, documentDate: date, description: `Trả tiền 2 ${stamp}`, partyCode: code, autoPost: true,
      ...(voucherType === 'BN' ? { bankAccountNo: '0099001' } : {}),
      lines: [{ accountCode: '331', partyCode: code, debit: amount2, credit: '0' }, { accountCode: voucherType === 'PC' ? '1111' : '1121', debit: '0', credit: amount2 }] } });
    expect(r.ok(), await r.text()).toBeTruthy(); return (await r.json()) as { id: string };
  };
  await mk2('PC', '2026-11-10'); await mk2('BN', '2026-11-11');

  await page.goto('/tien-ich/khu-trung');
  await expect(page.getByText('Khử trùng chứng từ').first()).toBeVisible();
  await page.getByRole('textbox').first().fill('01/11/2026'); await page.keyboard.press('Enter');
  await page.getByRole('textbox').nth(1).fill('30/11/2026'); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Tìm' }).click();

  const first = page.locator('[data-testid=dup-pair]').filter({ hasText: `Trả tiền ${stamp}` });
  await expect(first).toHaveCount(1);
  await expect(first).toContainText('Cùng số tiền');
  await expect(first).toContainText('Cùng đối tượng');
  await expect(first).toContainText(bn.voucherNo);

  // Không trùng cặp thứ hai: cặp biến mất, cặp đầu còn
  const second = page.locator('[data-testid=dup-pair]').filter({ hasText: `Trả tiền 2 ${stamp}` });
  await expect(second).toHaveCount(1);
  await second.getByRole('button', { name: 'Không trùng' }).click();
  await page.locator('.ant-popover').getByRole('button', { name: 'Không trùng' }).click(); // hỏi lại trước khi đánh dấu
  await expect(second).toHaveCount(0);
  await expect(first).toHaveCount(1);

  // Đảo phiếu chi: chứng từ đảo được lập, cặp biến mất
  await first.locator('[data-testid=dup-A], [data-testid=dup-B]').filter({ hasText: pc.voucherNo }).getByRole('button', { name: 'Đảo chứng từ' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Lập chứng từ đảo' }).click();
  await expect(page.getByText(/Đã tạo chứng từ đảo/)).toBeVisible();
  await expect(first).toHaveCount(0);
  const state = await (await request.get(`/api/vouchers/${pc.id}`)).json();
  expect(state.state).toBe('reversed');
});

test('Quy tắc khử trùng: sửa cửa sổ ngày trên màn Danh mục lưu được', async ({ page, request }) => {
  await signIn(page, request);
  const rules = (await (await request.get('/api/catalogs/voucher_dup_rule?size=100')).json()).rows as { id: number; type_a: string; type_b: string; days_window: number }[];
  const rule = rules.find((r) => r.type_a === 'PKT' && r.type_b === 'PT')!;
  expect(rule).toBeDefined();
  const next = rule.days_window === 4 ? 5 : 4;
  try {
    await page.goto('/danh-muc/voucher_dup_rule');
    const row = page.locator('.ag-row').filter({ has: page.locator('[col-id="type_a"]', { hasText: /^PKT$/ }) }).filter({ has: page.locator('[col-id="type_b"]', { hasText: /^PT$/ }) });
    await row.getByRole('button', { name: 'Sửa' }).click();
    await page.getByLabel('Cách tối đa (ngày)').fill(String(next));
    await page.getByRole('dialog').getByRole('button', { name: 'Đồng ý' }).click();
    await expect(page.getByText('Đã lưu')).toBeVisible();
    const after = (await (await request.get('/api/catalogs/voucher_dup_rule?size=100')).json()).rows as { id: number; days_window: number }[];
    expect(after.find((r) => r.id === rule.id)!.days_window).toBe(next);
  } finally {
    await request.put(`/api/catalogs/voucher_dup_rule/${rule.id}`, { data: { days_window: rule.days_window } }); // trả lại cấu hình cho các spec khác
  }
});
