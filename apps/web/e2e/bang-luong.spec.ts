import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';

// Yêu cầu trước khi chạy: pnpm -F @kt/api cli create-admin --username e2e --password Matkhau1! --tenant-code E2E --tenant-name "Công ty E2E"
// Mọi tham số lương trong spec là dữ liệu minh họa (nguồn ghi rõ), không phải văn bản pháp lý. Spec xóa mọi tham số lương của công ty E2E trước khi chạy.

async function login(request: APIRequestContext, username: string) {
  const r = await request.post('/api/auth/login', { data: { username, password: 'Matkhau1!' } });
  expect(r.ok()).toBeTruthy();
}
async function signIn(page: Page, request: APIRequestContext, username = 'e2e') {
  await login(request, username);
  await page.goto('/dang-nhap');
  await page.getByLabel('Tên đăng nhập').fill(username); await page.getByLabel('Mật khẩu').fill('Matkhau1!'); await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/dang-nhap/);
}
const ok = async (p: Promise<APIResponse>) => { const r = await p; expect(r.ok(), await r.text()).toBeTruthy(); return r; };

const SRC = 'Dữ liệu minh họa của kiểm thử e2e, không phải văn bản pháp lý';
const now = new Date(); const year = now.getFullYear(), month = now.getMonth() + 1;
const sfx = String(Date.now()).slice(-8);
const dept = { code: `BP${sfx}`, name: `Bộ phận lương ${sfx}` };
const emp = [{ code: `NA${sfx}`, name: `Nguyễn Văn A ${sfx}`, id: 0, days: 26 }, { code: `NB${sfx}`, name: `Trần Thị B ${sfx}`, id: 0, days: 13 }];
let deptId = 0;

// Lưới AG Grid chỉ vẽ các cột đang thấy: cuộn ngang dần cho tới khi ô cần tìm được vẽ ra.
async function cell(page: Page, rowIndex: number, colId: string) {
  const loc = page.getByTestId('payroll-grid').locator(`.ag-center-cols-container [row-index="${rowIndex}"] [col-id="${colId}"]`);
  const viewport = page.getByTestId('payroll-grid').locator('.ag-body-horizontal-scroll-viewport');
  await viewport.evaluate((el) => { el.scrollLeft = 0; });
  for (let x = 0; x < 8000; x += 400) {
    await viewport.evaluate((el, left) => { el.scrollLeft = left; }, x); await page.waitForTimeout(200); // AG Grid vẽ cột sau sự kiện cuộn
    if ((await loc.count()) > 0) break;
  }
  await expect(loc).toBeVisible();
  return loc;
}

test.describe.serial('bảng lương', () => {
  test.beforeAll(async ({ playwright }, testInfo) => {
    const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL! });
    await login(request, 'e2e');
    // Tham số lương cũ của công ty E2E bị xóa để kiểm thử xác định; thiếu biểu thuế cho tới khi nhập bằng giao diện.
    for (const p of (await (await request.get('/api/payroll/params')).json()) as { id: number }[]) await ok(request.delete(`/api/payroll/params/${p.id}`));
    const put = (code: string, value: unknown) => ok(request.put('/api/payroll/params', { data: { code, validFrom: '2000-01-01', validTo: null, value, source: SRC } }));
    await put('pit_deduction', { self: '4000000', dependent: '1600000' });
    await put('si_rates', { employee: { si: 8, hi: 1.5, ui: 1 }, employer: { si: 17.5, hi: 3, ui: 1, occupational: 0.5 } });
    await put('si_ceiling', { si_base_max: '36000000' });
    await ok(request.put('/api/settings', { data: { payroll_standard_hours_per_day: '8', payroll_standard_days_per_month: '26' } }));
    deptId = Number((await (await ok(request.post('/api/catalogs/department', { data: dept }))).json()).id);
    for (const e of emp) {
      e.id = Number((await (await ok(request.post('/api/catalogs/employee', { data: { code: e.code, name: e.name, department_code: dept.code } }))).json()).id);
      await ok(request.put(`/api/payroll/profiles/${e.id}`, { data: { payMethod: 'cash', taxResidency: 'resident', contractType: 'long', startDate: '2020-01-01', region: 'I',
        siParticipates: true, hiParticipates: true, uiParticipates: true, occupationalParticipates: false } }));
      await ok(request.post(`/api/payroll/profiles/${e.id}/salary-history`, { data: { validFrom: '2020-01-01', monthlySalary: '10000000' } }));
    }
    const cells = emp.flatMap((e) => Array.from({ length: e.days }, (_, i) => ({ employeeId: e.id, date: `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`, entries: [{ kind: 'work_day', qty: '1' }] })));
    await ok(request.put(`/api/attendance?year=${year}&month=${month}&departmentId=${deptId}`, { data: { cells } }));
    await request.dispose();
  });

  test('tạo bảng lương, thiếu biểu thuế thì dẫn sang Tham số lương, nhập rồi Tính, sửa ô thưởng tay thì dòng tính lại', async ({ page, request }) => {
    await signIn(page, request);
    await page.goto('/luong/bang-luong');
    await expect(page.getByRole('heading', { name: 'Bảng lương' })).toBeVisible();

    // Tạo bảng lương theo bộ phận (chỉ hai nhân viên của kiểm thử)
    await page.getByRole('button', { name: 'Tạo bảng lương' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('combobox', { name: 'Bộ phận' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type(dept.code);
    await page.locator('.ant-select-item-option', { hasText: new RegExp(dept.code) }).click();
    await dlg.getByRole('button', { name: 'Tạo', exact: true }).click();
    await expect(page.getByTestId('run-detail')).toBeVisible();
    await expect(page.getByTestId('run-status')).toHaveText('Nháp');
    await expect(page.getByTestId('run-detail').getByText('2 nhân viên').first()).toBeVisible();

    // Chưa có biểu thuế lũy tiến: Tính báo thiếu tham số kèm liên kết sang màn tham số
    await page.getByRole('button', { name: 'Tính (F9)' }).click();
    const alert = page.locator('.ant-alert-error');
    await expect(alert).toContainText('Thiếu tham số');
    await alert.getByRole('link', { name: /Mở màn Tham số lương/ }).click();
    await expect(page).toHaveURL(/\/luong\/tham-so/);
    await expect(page.getByTestId('params-banner')).toContainText('phần mềm không có mặc định');
    await expect(page.getByTestId('illustrative-warning')).toBeVisible(); // các tham số nhập qua API ghi nguồn minh họa

    // Nhập biểu thuế hai bậc bằng hộp thoại có cấu trúc (không điền sẵn giá trị nào)
    await page.getByRole('tab', { name: 'Các dòng đã nhập' }).click();
    await page.getByRole('button', { name: 'Thêm tham số' }).click();
    const pd = page.getByRole('dialog');
    await pd.getByRole('combobox', { name: 'Tham số' }).click(); await page.locator('.ant-select-item-option', { hasText: 'Biểu thuế thu nhập cá nhân lũy tiến (theo tháng)' }).click();
    await expect(pd.getByLabel('Bậc 1 thuế suất')).toHaveValue('');
    await pd.getByLabel('Hiệu lực từ ngày').fill('01/01/2000'); await page.keyboard.press('Enter');
    await pd.getByRole('button', { name: 'Thêm bậc' }).click(); // mới chỉ có bậc cuối không giới hạn
    await pd.getByLabel('Bậc 1 đến mức').fill('5000000'); await pd.getByLabel('Bậc 1 thuế suất').fill('5');
    await pd.getByLabel('Bậc 2 thuế suất').fill('10');
    await pd.getByRole('button', { name: 'Lưu', exact: true }).click();
    await expect(pd.locator('.ant-alert-error')).toContainText('nguồn'); // chưa ghi nguồn văn bản: bị chặn
    await pd.getByLabel('Nguồn văn bản').fill(SRC);
    await expect(pd.locator('.ant-alert-warning')).toContainText('dữ liệu minh họa');
    await pd.getByRole('button', { name: 'Lưu', exact: true }).click();
    await expect(page.getByText('Đã lưu tham số')).toBeVisible();
    await expect(page.getByTestId('param-list').getByText('2 bậc: đến 5.000.000: 5%; trên 5.000.000: 10%')).toBeVisible();

    // Quay lại bảng lương, chọn bảng vừa tạo, Tính bằng F9
    await page.goto('/luong/bang-luong');
    await page.getByTestId('run-list').getByText(dept.name).click();
    await expect(page.getByTestId('run-status')).toHaveText('Nháp');
    await page.keyboard.press('F9');
    await expect(page.getByTestId('run-status')).toHaveText('Đã tính');
    // NA: lương 10.000.000 đủ 26 công, BH người lao động 10,5% = 1.050.000, thuế 5% trên (10.000.000 - 1.050.000 - 4.000.000) = 247.500
    await expect(await cell(page, 0, 'gross')).toHaveText('10.000.000');
    await expect(await cell(page, 0, 'net')).toHaveText('8.702.500');
    await expect(await cell(page, 1, 'base_salary')).toHaveText('5.000.000'); // NB: 13/26 công

    // Sửa tay ô Thưởng của NA: dòng tính lại ngay, ô đánh dấu đã sửa tay
    const put = page.waitForResponse((r) => r.url().includes('/values') && r.request().method() === 'PUT');
    const bonus = await cell(page, 0, 'bonus');
    await bonus.click(); await page.keyboard.press('Control+a'); await page.keyboard.type('1.000.000'); await page.keyboard.press('Enter');
    expect((await put).ok()).toBeTruthy();
    await page.keyboard.press('Escape');
    await expect(await cell(page, 0, 'bonus')).toHaveText('1.000.000');
    await expect(await cell(page, 0, 'bonus')).toHaveCSS('font-weight', '600');
    await expect(await cell(page, 0, 'gross')).toHaveText('11.000.000');
    // thuế: 5% của 5.000.000 + 10% của 950.000 = 345.000; thực lĩnh = 11.000.000 - 1.050.000 - 345.000
    await expect(await cell(page, 0, 'net')).toHaveText('9.605.000');
    const run = (await (await request.get(`/api/payroll/runs?year=${year}&month=${month}`)).json()).find((r: { name: string }) => r.name.includes(dept.name));
    const detail = await (await request.get(`/api/payroll/runs/${run.id}`)).json();
    expect(detail.lines.find((l: { employeeCode: string }) => l.employeeCode === emp[0]!.code)).toMatchObject({ net: '9605000', manual: ['bonus'] });
    expect(detail.stale).toBe(false);

    // Hàng tổng cộng cuối lưới cộng cả hai nhân viên
    const net = detail.lines.reduce((s: number, l: { net: string }) => s + Number(l.net), 0);
    await page.getByTestId('payroll-grid').locator('.ag-body-horizontal-scroll-viewport').evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(page.getByTestId('payroll-grid').locator('.ag-floating-bottom').getByText('Tổng cộng')).toBeVisible();
    await expect(page.getByTestId('payroll-grid').locator('.ag-floating-bottom [col-id="net"]')).toHaveText(new Intl.NumberFormat('vi-VN').format(net));

    // Đổi chấm công sau khi tính: bảng báo Cần tính lại
    await ok(request.put(`/api/attendance?year=${year}&month=${month}&departmentId=${deptId}`, { data: { cells: [{ employeeId: emp[1]!.id, date: `${year}-${String(month).padStart(2, '0')}-20`, entries: [{ kind: 'work_day', qty: '1' }] }] } }));
    await page.reload();
    await page.getByTestId('run-list').getByText(dept.name).click();
    await expect(page.getByTestId('run-stale')).toBeVisible();
    await expect(page.getByTestId('run-detail').getByText('Cần tính lại').first()).toBeVisible();
  });

  test('cấu trúc bảng lương: thêm cột công thức, kiểm với một nhân viên, cấu trúc đã dùng bị khóa và nhân bản được', async ({ page, request }) => {
    await signIn(page, request);
    await page.goto('/luong/cau-truc');
    await expect(page.getByRole('heading', { name: 'Cấu trúc bảng lương' })).toBeVisible();

    await page.getByRole('button', { name: 'Thêm cấu trúc' }).click();
    await page.getByLabel('Mã cấu trúc', { exact: true }).fill(`CC${sfx}`); await page.getByLabel('Tên cấu trúc', { exact: true }).fill(`Có chuyên cần ${sfx}`);
    await page.getByRole('button', { name: 'Thêm cột công thức' }).click();
    await page.getByLabel('Mã cột').last().fill('chuyen_can'); await page.getByLabel('Tên cột').last().fill('Thưởng chuyên cần');
    await page.getByLabel('Thu nhập (chuyen_can)').check();
    // Công thức sai (cột không có) bị báo ngay; sửa lại bằng gợi ý mã cột
    const formula = page.getByLabel('Công thức', { exact: true });
    await formula.fill('IF([work_dayz] >= 26, 500000, 0)');
    await expect(page.getByTestId('structure-problem')).toContainText('work_dayz');
    await formula.fill('IF([work_da');
    await page.locator('.ant-select-item-option', { hasText: 'work_days - Ngày công hưởng lương' }).click();
    await expect(formula).toHaveValue('IF([work_days]');
    await formula.fill('IF([work_days] >= 26, 500000, 0)');
    await expect(page.getByTestId('structure-problem')).toHaveCount(0);
    await formula.press('Control+s');
    await expect(page.getByText('Đã lưu cấu trúc bảng lương')).toBeVisible();

    // Kiểm công thức với nhân viên NA (đủ 26 công): cột chuyên cần = 500.000
    await page.getByRole('combobox', { name: 'Nhân viên xem thử' }).focus(); await page.keyboard.press('F4'); await page.keyboard.type(emp[0]!.code);
    await page.locator('.ant-select-item-option', { hasText: new RegExp(emp[0]!.code) }).click();
    await page.getByRole('button', { name: 'Kiểm công thức' }).click();
    const result = page.getByTestId('preview-result');
    await expect(result.getByRole('row', { name: /chuyen_can - Thưởng chuyên cần/ })).toContainText('500.000');
    await expect(page.getByTestId('preview-net')).not.toHaveText('');

    // Cấu trúc mặc định đã được bảng lương đã tính dùng: khóa sửa, gợi ý nhân bản
    await page.getByTestId('structure-list').getByText('LUONG_CO_BAN').click();
    await expect(page.getByText('Cấu trúc đã được bảng lương dùng nên không sửa được')).toBeVisible();
    await expect(page.getByRole('button', { name: /Lưu cấu trúc/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Nhân bản' }).first().click();
    await page.getByLabel('Mã cấu trúc mới').fill(`BS${sfx}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Nhân bản', exact: true }).click();
    await expect(page.getByText('Đã nhân bản cấu trúc')).toBeVisible();
    await expect(page.getByTestId('structure-list').getByText(`BS${sfx}`)).toBeVisible();
    await expect(page.getByRole('button', { name: /Lưu cấu trúc/ })).toBeVisible(); // bản sao sửa được
  });

  test('người dùng không có cờ xem lương: không thấy Bảng lương và Cấu trúc, trang báo không có quyền', async ({ request, browser, baseURL }) => {
    await login(request, 'e2e');
    const username = `nl${String(Date.now()).slice(-8)}`;
    await ok(request.post('/api/users', { data: { username, fullName: 'Không xem lương', password: 'Matkhau1!', roleCode: 'ketoan_vien', sensitiveFlags: [] } }));
    const ctx = await browser.newContext({ baseURL: baseURL!, locale: 'vi-VN' });
    const p2 = await ctx.newPage();
    await signIn(p2, ctx.request, username);
    await expect(p2.getByRole('link', { name: 'Bảng lương' })).toHaveCount(0);
    await expect(p2.getByRole('link', { name: 'Cấu trúc bảng lương' })).toHaveCount(0);
    for (const path of ['/luong/bang-luong', '/luong/cau-truc']) { await p2.goto(path); await expect(p2.getByText('Không có quyền xem lương').first()).toBeVisible(); }
    expect((await ctx.request.get('/api/payroll/runs?year=2026')).status()).toBe(403);
    await ctx.close();
  });
});
