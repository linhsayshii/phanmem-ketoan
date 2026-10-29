import { afterEach, describe, expect, it, vi } from 'vitest';
import { friendlyMessage, issueText } from '../src/api/errors.js';
import { ApiError, api, apiBlob } from '../src/api/client.js';
import { dedupeErrorToasts } from '../src/api/toast.js';

const raw = 'params/year Expected number, received nan';

describe('friendlyMessage: lỗi kiểm tra dữ liệu (VALIDATION)', () => {
  it('không lộ "params/year Expected number, received nan"', () => {
    const t = friendlyMessage({ status: 400, code: 'VALIDATION', message: raw });
    expect(t).toBe('Dữ liệu chưa hợp lệ. Năm: phải là số');
    expect(t).not.toMatch(/params|Expected|nan/);
  });
  it('dùng details (danh sách lỗi zod có path) khi máy chủ gửi kèm', () => {
    const details = [{ path: ['year'], code: 'invalid_type', expected: 'number', received: 'nan', message: 'Expected number, received nan', scope: 'params' }];
    expect(friendlyMessage({ status: 400, code: 'VALIDATION', message: raw, details })).toBe('Dữ liệu chưa hợp lệ. Năm: phải là số');
  });
  it('nhiều lỗi trong một thông báo thô: tách theo phạm vi, gộp trùng, cắt sau 3 lỗi', () => {
    const m = 'body/bookForm Required, body/rows/2/amount Expected number, received string, querystring/from Required, querystring/to Required, params/year Required';
    const t = friendlyMessage({ status: 400, code: 'VALIDATION', message: m });
    expect(t).toBe('Dữ liệu chưa hợp lệ. Hình thức sổ: bắt buộc nhập; Dòng 3 – Số tiền: phải là số; Từ ngày: bắt buộc nhập; … (còn 2 lỗi khác)');
  });
  it('tên trường lạ không bị lộ ra', () => {
    expect(friendlyMessage({ status: 400, code: 'VALIDATION', message: 'body/zzTrangThaiNoiBo Required' })).toBe('Dữ liệu chưa hợp lệ. Thiếu thông tin bắt buộc');
  });
  it('lỗi zod phổ biến → tiếng Việt', () => {
    expect(issueText({ path: ['name'], code: 'too_small', type: 'string', minimum: 1 })).toBe('Tên: không được để trống');
    expect(issueText({ path: ['amount'], code: 'too_small', type: 'number', minimum: 0 })).toBe('Số tiền: không được nhỏ hơn 0');
    expect(issueText({ path: ['rows'], code: 'too_small', type: 'array', minimum: 1 })).toBe('Danh sách dòng: phải có ít nhất 1 dòng');
    expect(issueText({ path: ['bookForm'], code: 'invalid_enum_value' })).toBe('Hình thức sổ: không nằm trong các giá trị cho phép');
    expect(issueText({ path: ['email'], code: 'invalid_string', validation: 'email' })).toBe('Email: không phải địa chỉ email hợp lệ');
    expect(issueText({ path: ['from'], code: 'invalid_string', validation: 'regex', message: 'Invalid' })).toBe('Từ ngày: sai định dạng');
  });
  it('thông báo tiếng Việt của máy chủ (custom) được giữ nguyên', () => {
    const m = 'Có lương cơ bản thì phải nhập ngày hiệu lực';
    expect(issueText({ path: ['salaryFrom'], code: 'custom', message: m })).toBe(m);
  });
  it('VALIDATION không có chi tiết dùng được: chữ chung, không lộ chữ Anh', () => {
    expect(friendlyMessage({ status: 400, code: 'VALIDATION', message: 'something odd' })).toMatch(/kiểm tra lại/);
    expect(friendlyMessage({ status: 400, code: 'VALIDATION', message: 'Dữ liệu không hợp lệ' })).toBe('Dữ liệu không hợp lệ');
  });
});

describe('friendlyMessage: mã trạng thái và mã lỗi chung', () => {
  it('giữ nguyên thông báo nghiệp vụ tiếng Việt của máy chủ', () => {
    expect(friendlyMessage({ status: 409, code: 'VOUCHER_POSTED', message: 'Chứng từ đã ghi sổ' })).toBe('Chứng từ đã ghi sổ');
    expect(friendlyMessage({ status: 401, code: 'BAD_CREDENTIALS', message: 'Sai tên đăng nhập hoặc mật khẩu' })).toBe('Sai tên đăng nhập hoặc mật khẩu');
  });
  it.each([[401, /đăng nhập/], [403, /quyền/], [404, /Không tìm thấy/], [409, /trạng thái/], [413, /quá lớn/], [429, /quá nhanh/], [500, /Lỗi hệ thống/], [502, /không phản hồi/], [503, /bảo trì/], [418, /kiểm tra lại/]])(
    'thông báo tiếng Anh của HTTP %i bị thay bằng chữ Việt', (status, re) => {
      const t = friendlyMessage({ status, code: 'HTTP', message: 'Unauthorized' });
      expect(t).toMatch(re); expect(t).not.toMatch(/Unauthorized/);
    });
  it('không có thân lỗi: dùng chữ theo trạng thái', () => {
    expect(friendlyMessage({ status: 404, code: 'HTTP_404' })).toMatch(/Không tìm thấy/);
  });
  it('NETWORK, INTERNAL, FILE_TOO_LARGE có chữ riêng', () => {
    expect(friendlyMessage({ status: 0, code: 'NETWORK' })).toMatch(/Không kết nối được máy chủ/);
    expect(friendlyMessage({ status: 500, code: 'INTERNAL', message: 'Lỗi hệ thống' })).toMatch(/Lỗi hệ thống/);
    expect(friendlyMessage({ status: 413, code: 'FILE_TOO_LARGE', message: 'Tệp quá lớn, tối đa 20 MB' })).toBe('Tệp quá lớn, tối đa 20 MB');
  });
  it('FORBIDDEN "Thiếu quyền x.y" nói rõ quyền cần cấp', () => {
    expect(friendlyMessage({ status: 403, code: 'FORBIDDEN', message: 'Thiếu quyền period.update' })).toMatch(/chưa được cấp quyền.*period\.update.*quản trị viên/);
  });
});

describe('api(): lỗi và tham số thiếu', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));

  it('đường dẫn có undefined/NaN bị chặn tại máy khách, không gọi fetch', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    for (const p of ['/api/fiscal-years/undefined/book-form', '/api/x/NaN', '/api/opening-balance/NaN/check?a=1', '/api/cit/template?year=NaN', '/api/z?from=2026-01-01&year=undefined']) {
      await expect(api(p)).rejects.toMatchObject({ code: 'MISSING_PARAM', message: expect.stringMatching(/Chưa chọn đủ thông tin/) });
    }
    await expect(apiBlob('/api/y/undefined')).rejects.toMatchObject({ code: 'MISSING_PARAM' });
    expect(f).not.toHaveBeenCalled();
  });
  it('không chặn nhầm đường dẫn hợp lệ có chữ gần giống', async () => {
    stub(200, { ok: true });
    await expect(api('/api/catalogs/item?q=undefinedBehavior&size=1')).resolves.toEqual({ ok: true });
    await expect(api('/api/x/NaNa')).resolves.toEqual({ ok: true });
  });
  it('400 VALIDATION thô của fastify → ApiError.message tiếng Việt, giữ thông báo gốc ở raw', async () => {
    stub(400, { error: { code: 'VALIDATION', message: raw } });
    const e = await api('/api/x').catch((x: unknown) => x) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect([e.status, e.code, e.message, e.raw]).toEqual([400, 'VALIDATION', 'Dữ liệu chưa hợp lệ. Năm: phải là số', raw]);
  });
  it('lỗi nghiệp vụ tiếng Việt giữ nguyên; thân không phải JSON dùng chữ theo trạng thái; mất mạng có chữ riêng', async () => {
    stub(409, { error: { code: 'PERIOD_LOCKED', message: 'Kỳ đã khóa sổ', details: { a: 1 } } });
    await expect(api('/api/x')).rejects.toMatchObject({ code: 'PERIOD_LOCKED', message: 'Kỳ đã khóa sổ', details: { a: 1 } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })));
    await expect(api('/api/x')).rejects.toMatchObject({ code: 'HTTP_502', message: expect.stringMatching(/không phản hồi/) });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(api('/api/x')).rejects.toMatchObject({ code: 'NETWORK', message: expect.stringMatching(/Không kết nối được máy chủ/) });
  });
  it('apiBlob dịch lỗi từ thân JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Thiếu quyền report.print' } }), { status: 403 })));
    await expect(apiBlob('/api/f')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403, message: expect.stringMatching(/report\.print/) });
  });
});

describe('dedupeErrorToasts', () => {
  it('toast lỗi cùng nội dung dùng chung key để antd không xếp chồng', () => {
    const calls: unknown[][] = [];
    const target = { error: (...a: unknown[]) => { calls.push(a); } };
    dedupeErrorToasts(target); dedupeErrorToasts(target); // gọi lần hai không bọc hai lớp
    (target.error as (c: unknown, ...r: unknown[]) => void)('Lỗi A', 5);
    (target.error as (c: unknown, ...r: unknown[]) => void)('Lỗi A');
    (target.error as (c: unknown, ...r: unknown[]) => void)({ content: 'Lỗi B', duration: 10 });
    (target.error as (c: unknown, ...r: unknown[]) => void)({ content: 'Lỗi C', key: 'riêng' });
    expect(calls).toEqual([
      [{ content: 'Lỗi A', key: 'error:Lỗi A' }, 5],
      [{ content: 'Lỗi A', key: 'error:Lỗi A' }],
      [{ content: 'Lỗi B', duration: 10, key: 'error:Lỗi B' }],
      [{ content: 'Lỗi C', key: 'riêng' }],
    ]);
  });
});
