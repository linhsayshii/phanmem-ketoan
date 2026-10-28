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
const pickF4 = async (page: Page, combo: string, code: string) => {
  await page.getByRole('combobox', { name: combo }).focus(); await page.keyboard.press('F4'); await page.keyboard.type(code);
  await page.locator('.ant-select-item-option', { hasText: code }).first().click();
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0); // chờ dropdown đóng: antd trả tiêu điểm về ô vừa chọn sau hiệu ứng đóng
};

test('đối tượng tập hợp chi phí, định mức NVL bằng bàn phím và cột Đối tượng THCP (F4) trên phiếu kế toán', async ({ page, request }) => {
  await signIn(page, request);
  const sfx = Date.now().toString(36).toUpperCase().slice(-6);
  const tp = `TP-${sfx}`; const nvl = `NVL-${sfx}`; const obj = `DT-${sfx}`;
  await request.post('/api/catalogs/uom', { data: { code: 'CAI', name: 'Cái' } }); // trùng mã từ lần chạy trước thì bỏ qua
  for (const [code, name, kind] of [[tp, 'Bàn gỗ E2E', 'finished'], [nvl, 'Gỗ tấm E2E', 'material']])
    expect((await request.post('/api/catalogs/item', { data: { code, name, base_uom_code: 'CAI', kind } })).ok()).toBeTruthy();

  // 1. Đối tượng tập hợp chi phí: Insert, nhập, chọn sản phẩm bằng F4, Ctrl+S
  await page.goto('/gia-thanh/doi-tuong');
  await expect(page.getByRole('heading', { name: 'Đối tượng tập hợp chi phí' })).toBeVisible();
  await page.keyboard.press('Insert');
  await page.getByLabel('Mã', { exact: true }).fill(obj); await page.getByLabel('Tên đối tượng').fill(`Bàn gỗ ${sfx}`);
  await pickF4(page, 'Sản phẩm', tp);
  await page.getByLabel('Tên đối tượng').press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu đối tượng tập hợp chi phí')).toBeVisible();
  await expect(page.getByTestId('cost-objects').getByRole('row', { name: new RegExp(obj) })).toContainText(tp);

  // 2. Định mức NVL cho sản phẩm: dòng NVL nhập trên lưới bằng bàn phím
  await page.goto('/gia-thanh/dinh-muc');
  await expect(page.getByRole('heading', { name: 'Định mức nguyên vật liệu' })).toBeVisible();
  await page.keyboard.press('Insert');
  await pickF4(page, 'Sản phẩm', tp);
  const cell = (row: number, col: string) => page.locator(`.ant-modal .ag-center-cols-container .ag-row[row-index="${row}"] [col-id="${col}"]`);
  await cell(0, 'itemCode').dblclick(); await page.keyboard.type(nvl); await page.keyboard.press('Tab');
  await cell(0, 'quantity').dblclick(); await page.keyboard.type('2,5'); await page.keyboard.press('Tab');
  await cell(0, 'lossPercent').dblclick(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('2'); await page.keyboard.press('Tab');
  await expect(cell(0, 'grossQuantity')).toContainText('2,55');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.ant-message').getByText('Đã lưu định mức')).toBeVisible();
  await expect(page.getByTestId('cost-norms').getByRole('row', { name: new RegExp(tp) })).toBeVisible();
  const norms = await (await request.get(`/api/costing/norms?itemCode=${tp}`)).json() as { id: number }[];
  expect(norms).toHaveLength(1);
  expect((await (await request.get(`/api/costing/norms/${norms[0]!.id}`)).json()).lines).toEqual([expect.objectContaining({ itemCode: nvl, quantity: '2.500000', lossPercent: '2.0000', grossQuantity: '2.550000' })]);

  // 3. Phiếu kế toán: dòng 154 hiện cột Đối tượng THCP, chọn bằng F4 rồi ghi sổ
  const regime = ((await (await request.get('/api/fiscal-years')).json()) as { regime: string; dateFrom: string }[]).find((y) => y.dateFrom <= '2026-01-21')!.regime;
  const cash = regime === 'TT133' ? '1111' : '111';
  await page.goto('/chung-tu/PKT/moi');
  await page.getByLabel('Ngày hạch toán').fill('21/01/2026'); await page.keyboard.press('Enter');
  await page.getByLabel('Diễn giải').fill(`Chi phí sản xuất ${sfx}`);
  const vcell = (row: number, col: string) => page.locator(`.ag-center-cols-container .ag-row[row-index="${row}"] [col-id="${col}"]`);
  await expect(page.locator('.ag-header-cell', { hasText: 'Đối tượng THCP' })).toHaveCount(0); // chưa có dòng chi phí sản xuất
  await vcell(0, 'accountCode').click(); await page.keyboard.type('154'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await page.keyboard.type('300000'); await page.keyboard.press('Enter');
  await expect(page.locator('.ag-header-cell', { hasText: 'Đối tượng THCP' })).toBeVisible();
  await vcell(0, 'costObjectCode').click(); await page.keyboard.press('F4');
  await expect(page.getByRole('dialog').getByRole('combobox')).toBeFocused(); await page.keyboard.type(obj);
  await page.locator('.ant-select-item-option', { hasText: obj }).click();
  await expect(page.locator('.ag-center-cols-container [col-id="costObjectCode"]', { hasText: obj })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();
  await vcell(1, 'accountCode').click(); await page.keyboard.type(cash); await page.keyboard.press('Enter');
  await vcell(1, 'credit').click(); await page.keyboard.type('300000'); await page.keyboard.press('Enter');
  await page.keyboard.press('F9');
  await expect(page.locator('.ant-message').getByText('Đã ghi sổ')).toBeVisible();
  const id = page.url().split('/').at(-1)!;
  const saved = await (await request.get(`/api/vouchers/${id}`)).json() as { state: string; lines: { accountCode: string; costObjectCode: string | null }[] };
  expect(saved.state).toBe('posted');
  expect(saved.lines.map((l) => [l.accountCode, l.costObjectCode])).toEqual([['154', obj], [cash, null]]);
});
