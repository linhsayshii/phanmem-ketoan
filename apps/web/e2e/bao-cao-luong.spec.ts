import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"
// Tham số lương là dữ liệu minh họa (nguồn ghi rõ), không phải văn bản pháp lý. Spec xóa mọi tham số lương của công ty E2E trước khi chạy.
// exceljs là phụ thuộc của @kt/api (web không cài): nạp qua createRequire từ gói api, chỉ khai báo phần dùng.
interface Workbook { xlsx: { load(b: unknown): Promise<unknown>; writeBuffer(): Promise<ArrayBuffer> }; getWorksheet(n: string): { getRow(n: number): { values: unknown } } }
const ExcelJS = createRequire(new URL('../../api/package.json', import.meta.url))('exceljs') as { Workbook: new () => Workbook };

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
const runName = `Lương báo cáo ${sfx}`, bonusName = `Thưởng báo cáo ${sfx}`;
const names = [`Lê Văn C ${sfx}`, `Phạm Thị D ${sfx}`];
const codes = [`CA${sfx}`, `CB${sfx}`];
let bonusId = 0;

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
  for (const [i, code] of codes.entries()) {
    const id = Number((await (await ok(request.post('/api/catalogs/employee', { data: { code, name: names[i], id_number: `0010${sfx}${i}` } }))).json()).id);
    await ok(request.put(`/api/payroll/profiles/${id}`, { data: { taxResidency: 'resident', contractType: 'long', startDate: '2020-01-01', region: 'I', siNo: `BH${sfx}${i}`,
      siParticipates: true, hiParticipates: true, uiParticipates: true, occupationalParticipates: false } }));
    await ok(request.post(`/api/payroll/profiles/${id}/salary-history`, { data: { validFrom: '2020-01-01', monthlySalary: '12000000' } }));
    ids.push(id);
  }
  const cells = ids.flatMap((employeeId) => Array.from({ length: 26 }, (_, i) => ({ employeeId, date: `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`, entries: [{ kind: 'work_day', qty: '1' }] })));
  await ok(request.put(`/api/attendance?year=${year}&month=${month}`, { data: { cells } }));
  const run = (await (await ok(request.post('/api/payroll/runs', { data: { year, month, employeeIds: ids, name: runName } }))).json()) as { id: number };
  await ok(request.post(`/api/payroll/runs/${run.id}/calculate`));
  await ok(request.post(`/api/payroll/runs/${run.id}/post`));
  // Bảng thưởng cùng tháng, chưa hạch toán: để thử nhập từ Excel.
  const bonus = (await (await ok(request.post('/api/payroll/runs', { data: { year, month, kind: 'bonus', employeeIds: ids, name: bonusName } }))).json()) as { id: number };
  bonusId = bonus.id;
  await ok(request.post(`/api/payroll/runs/${bonus.id}/calculate`));
  await request.dispose();
});

test('báo cáo lương: bảng thanh toán khớp sổ cái, phiếu lương in được, tệp BHXH', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/luong/bao-cao');
  await page.getByRole('combobox', { name: 'Tháng' }).click({ force: true }); await page.locator('.ant-select-item-option', { hasText: `Tháng ${month}` }).last().click();
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0); // chờ dropdown tháng đóng hẳn rồi mới mở ô Bảng lương
  await page.getByRole('combobox', { name: 'Bảng lương' }).click({ force: true }); await page.locator('.ant-select-item-option', { hasText: runName }).click();
  await expect(page.getByText(names[0]!)).toBeVisible(); await expect(page.getByText(names[1]!)).toBeVisible();
  await expect(page.getByTestId('recon')).toContainText('Khớp sổ cái');

  await page.getByRole('tab', { name: 'Tổng hợp bảo hiểm' }).click();
  await expect(page.getByTestId('recon')).toBeVisible();

  await page.getByRole('tab', { name: 'Phiếu lương' }).click();
  await page.getByRole('combobox', { name: 'Bảng lương' }).click({ force: true }); await page.locator('.ant-select-item-option', { hasText: runName }).click();
  await expect(page.getByText(names[1]!)).toBeVisible();
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'In phiếu lương' }).click()]);
  await expect(popup.getByText('PHIẾU LƯƠNG')).toHaveCount(2);
  await expect(popup.getByText(names[0]!, { exact: false }).first()).toBeVisible();
  await popup.close();

  await page.getByRole('tab', { name: 'Tệp BHXH' }).click();
  await expect(page.getByText('Chưa phải mẫu D02-LT')).toBeVisible();
});

test('nhập bảng lương từ Excel: lỗi từng dòng rồi nhập hợp lệ, bảng chuyển Cần tính lại', async ({ page, request }) => {
  await signIn(page, request);
  const tpl = await (await ok(request.get(`/api/payroll/runs/${bonusId}/import/template.xlsx`))).body();
  const make = async (rows: (string | number)[][]) => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(tpl as unknown as ArrayBuffer);
    rows.forEach((r, i) => { wb.getWorksheet('Du_lieu')!.getRow(4 + i).values = r; });
    return { name: 'luong.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
  };
  await page.goto('/luong/bang-luong');
  await page.getByTestId('run-list').getByText(bonusName).click();
  await page.getByRole('button', { name: 'Nhập từ Excel' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.locator('input[type=file]').setInputFiles(await make([[codes[0]!, 500000], ['KHONGCO', 1]]));
  await dlg.getByRole('button', { name: 'Kiểm tra' }).click();
  await expect(dlg.getByText('1 lỗi, chưa nhập dòng nào')).toBeVisible();
  await expect(dlg.getByText('KHONGCO')).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Nhập', exact: true })).toBeDisabled();

  await dlg.locator('input[type=file]').setInputFiles(await make([[codes[0]!, 500000], [codes[1]!, 700000]]));
  await dlg.getByRole('button', { name: 'Kiểm tra' }).click();
  await expect(dlg.getByText('2 dòng hợp lệ')).toBeVisible();
  await dlg.getByRole('button', { name: 'Nhập', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('run-stale')).toBeVisible();
});
