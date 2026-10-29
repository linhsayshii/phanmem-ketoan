import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"

// exceljs nằm ở gói API, web không phụ thuộc nó: nạp từ đó để dựng tệp nhập từ chính mẫu tải về.
const ExcelJS = createRequire(new URL('../../api/package.json', import.meta.url))('exceljs');

async function signIn(page: Page, request: APIRequestContext) {
  expect((await request.post('/api/auth/login', { data: { username: 'e2e', password: 'Matkhau1!' } })).ok()).toBeTruthy();
  const years = await (await request.get('/api/fiscal-years')).json();
  if (!years.length) expect((await request.post('/api/fiscal-years', { data: { fiscalYear: 2026, dateFrom: '2026-01-01', months: 12, regime: 'TT133' } })).ok()).toBeTruthy();
  await request.post('/api/catalogs/party', { data: { code: 'KH-E2E', name: 'Khách hàng E2E' } }); // đã có từ lần chạy trước thì bỏ qua lỗi trùng mã
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill('e2e'); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}

// Mẫu tải từ API + một dòng dữ liệu ở dòng 4, đặt cột theo dòng khóa kỹ thuật (dòng 2)
async function fileFrom(request: APIRequestContext, row: Record<string, string>) {
  const tpl = await request.get('/api/import/vouchers/thu-chi/template.xlsx');
  expect(tpl.ok()).toBeTruthy();
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await tpl.body());
  const ws = wb.worksheets[0];
  ws.getRow(2).eachCell((cell: { value: unknown }, n: number) => { const v = row[String(cell.value)]; if (v !== undefined) ws.getRow(4).getCell(n).value = v; });
  return { name: 'nhap.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
}

test('Nhập chứng từ từ Excel: tệp có lỗi báo dòng và cột, tệp đúng thì Kiểm tra rồi Nhập', async ({ page, request }) => {
  await signIn(page, request);
  const group = `E2E${Date.now()}`.slice(0, 28);
  const good = { group, type: 'PT', postingDate: '2026-01-15', description: 'Thu tiền nhập từ Excel', partyCode: 'KH-E2E', debitAccount: '1111', creditAccount: '131', amount: '1500000' };
  await page.goto('/chung-tu/nhap-excel');
  await expect(page.getByRole('heading', { level: 1, name: 'Nhập chứng từ từ Excel' })).toBeVisible();
  const upload = page.locator('input[type=file]');
  const nhap = page.getByRole('button', { name: 'Nhập', exact: true });

  // Ngày hạch toán không phải ngày: lỗi nêu cột Ngày hạch toán; nút Nhập vẫn khóa
  await upload.setInputFiles(await fileFrom(request, { ...good, postingDate: 'không phải ngày' }));
  await page.getByRole('button', { name: 'Kiểm tra' }).click();
  await expect(page.getByText(/1 lỗi, chưa tạo chứng từ nào/)).toBeVisible();
  await expect(page.locator('.ant-table-row', { hasText: 'Ngày hạch toán' })).toContainText('Ngày không hợp lệ');
  await expect(nhap).toBeDisabled();

  // Tệp đúng: Kiểm tra không ghi gì, rồi Nhập tạo bản nháp
  await upload.setInputFiles(await fileFrom(request, good));
  await expect(nhap).toBeDisabled(); // chọn tệp mới thì phải Kiểm tra lại
  await page.getByRole('button', { name: 'Kiểm tra' }).click();
  await expect(page.getByText(/Hợp lệ: 1 dòng, 1 chứng từ; sẽ tạo mới 1/)).toBeVisible();
  await nhap.click();
  await expect(page.getByText(/Đã tạo 1 chứng từ \(bản nháp\)/).first()).toBeVisible();

});
