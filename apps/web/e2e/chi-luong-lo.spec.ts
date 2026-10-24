import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"
// Tham số lương là dữ liệu minh họa (nguồn ghi rõ), không phải văn bản pháp lý. Spec xóa mọi tham số lương của công ty E2E trước khi chạy.

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}
const ok = async (p: Promise<APIResponse>) => { const r = await p; expect(r.ok(), await r.text()).toBeTruthy(); return r; };

const SRC = 'Dữ liệu minh họa của kiểm thử e2e, không phải văn bản pháp lý';
const now = new Date(); const year = now.getFullYear(), month = now.getMonth() + 1;
const sfx = String(Date.now()).slice(-8);
const runName = `Lương lô ${sfx}`, formatName = `Mẫu thử ${sfx}`;
const acct = `00${sfx}`; // số 0 đầu phải được giữ
let net = '';

test.beforeAll(async ({ playwright }, testInfo) => {
  const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL! });
  await ok(request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } }));
  if (!((await (await request.get('/api/fiscal-years')).json()) as unknown[]).length)
    await ok(request.post('/api/fiscal-years', { data: { fiscalYear: year, dateFrom: `${year}-01-01`, months: 12, regime: 'TT133' } }));
  for (const p of (await (await request.get('/api/payroll/params')).json()) as { id: number }[]) await ok(request.delete(`/api/payroll/params/${p.id}`));
  const put = (code: string, value: unknown) => ok(request.put('/api/payroll/params', { data: { code, validFrom: '2000-01-01', validTo: null, value, source: SRC } }));
  await put('pit_deduction', { self: '4000000', dependent: '1600000' });
  await put('si_rates', { employee: { si: 8, hi: 1.5, ui: 1 }, employer: { si: 17.5, hi: 3, ui: 1, occupational: 0.5 } });
  await put('si_ceiling', { si_base_max: '36000000' });
  await put('pit_brackets', [{ upTo: '5000000', rate: 5 }, { upTo: null, rate: 10 }]);
  await ok(request.put('/api/settings', { data: { payroll_standard_hours_per_day: '8', payroll_standard_days_per_month: '26', payroll_expense_account: '6421' } }));
  const ids: number[] = [];
  // Nhân viên đầu có tài khoản nhận; nhân viên sau thiếu số tài khoản nên thành cảnh báo.
  for (const [code, name, bank] of [[`LA${sfx}`, `Nguyễn Thị Ánh ${sfx}`, { bankName: 'Ngân hàng A', bankAccountNo: acct }], [`LB${sfx}`, `Trần Văn Bình ${sfx}`, {}]] as const) {
    const id = Number((await (await ok(request.post('/api/catalogs/employee', { data: { code, name } }))).json()).id);
    await ok(request.put(`/api/payroll/profiles/${id}`, { data: { taxResidency: 'resident', contractType: 'long', startDate: '2020-01-01', region: 'I',
      siParticipates: true, hiParticipates: true, uiParticipates: true, occupationalParticipates: false, ...bank } }));
    await ok(request.post(`/api/payroll/profiles/${id}/salary-history`, { data: { validFrom: '2020-01-01', monthlySalary: '12000000' } }));
    ids.push(id);
  }
  const cells = ids.flatMap((employeeId) => Array.from({ length: 26 }, (_, i) => ({ employeeId, date: `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`, entries: [{ kind: 'work_day', qty: '1' }] })));
  await ok(request.put(`/api/attendance?year=${year}&month=${month}`, { data: { cells } }));
  const run = (await (await ok(request.post('/api/payroll/runs', { data: { year, month, employeeIds: ids, name: runName } }))).json()) as { id: number };
  net = ((await (await ok(request.post(`/api/payroll/runs/${run.id}/calculate`))).json()) as { lines: { employeeId: number; net: string }[] }).lines.find((l) => l.employeeId === ids[0])!.net;
  await ok(request.post(`/api/payroll/runs/${run.id}/post`));
  await request.dispose();
});

test.describe.configure({ mode: 'serial' });

test('cấu hình mẫu tệp chi lương, xem thử và lưu', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/luong/mau-chi-luong');
  await expect(page.getByTestId('formats-banner')).toContainText('Chưa có mẫu tệp theo từng ngân hàng');
  await expect(page.getByTestId('format-list')).toContainText('Chung');
  await page.getByRole('button', { name: 'Thêm mẫu' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Tên mẫu').fill(formatName);
  await dlg.getByRole('button', { name: 'Thêm cột' }).click();
  await expect(dlg.getByTestId('format-columns').locator('tbody tr')).toHaveCount(5);
  await dlg.getByLabel('Bỏ dấu tiếng Việt').click();
  await dlg.getByRole('button', { name: 'Xem thử 5 dòng' }).click();
  const pv = dlg.getByTestId('format-preview');
  await expect(pv).toContainText('Dữ liệu minh họa');
  await expect(pv).toContainText('Nguyen Van An'); // đã bỏ dấu
  await expect(pv).toContainText('12500000'); // số tiền nguyên chuỗi, không định dạng
  await dlg.getByRole('button', { name: /Lưu/ }).click();
  await expect(page.getByTestId('format-list')).toContainText(formatName);
});

test('xuất tệp chi lương từ bảng lương đã hạch toán: cảnh báo người thiếu tài khoản, tải tệp', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/luong/bang-luong');
  await page.getByTestId('run-list').getByText(runName).click();
  await expect(page.getByTestId('run-status')).toHaveText('Đã hạch toán');
  await page.getByRole('button', { name: 'Xuất tệp chi lương' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.locator('.ant-select').first().click();
  await page.locator('.ant-select-item-option', { hasText: formatName }).click();
  await dlg.getByRole('button', { name: 'Xuất tệp', exact: true }).click();
  const res = dlg.getByTestId('payment-result');
  await expect(res).toContainText('Đã xuất 1 người');
  await expect(dlg.getByTestId('payment-warnings')).toContainText('chưa có số tài khoản nhận');
  const href = await res.getByTestId('payment-download').getAttribute('href');
  const file = await request.get(href!);
  expect(file.ok()).toBeTruthy();
  const text = (await file.body()).toString('utf8').replace(/^\uFEFF/, '');
  expect(text).toContain(acct);
  expect(text).toContain(net);
  expect(text).toContain(`Nguyen Thi Anh ${sfx}`); // mẫu đã bật bỏ dấu
  await expect(dlg.getByTestId('payment-batches')).toContainText(formatName);
});
