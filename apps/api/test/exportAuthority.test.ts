import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { sql } from 'kysely';
import { bootstrapTenant, createTestApp, type TestApp } from './helpers.js';
import { toCsv } from '../src/modules/tools/exportAuthority.js';
import type * as Html from '../src/modules/reporting/print/html.js';
import { assertPrintable, MAX_PRINT_ROWS, type ReportDoc } from '../src/modules/reporting/print/html.js';

// Bọc assertPrintable bằng vi.fn nhưng mặc định gọi hàm thật: chỉ ca PDF quá lớn mới ép nó ném lỗi, ca năm tài chính đọc các lần gọi để biết sổ của năm nào.
vi.mock('../src/modules/reporting/print/html.js', async (importOriginal) => {
  const m = await importOriginal<typeof Html>();
  return { ...m, assertPrintable: vi.fn(m.assertPrintable) };
});
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 }); // PDF dựng bằng Chromium

let ctx: TestApp; let cookie: string; let tenantId: string;
const exportBody = { from: '2026-01-01', to: '2026-01-31' };
const post = (payload: object, c = cookie) => ctx.app.inject({ method: 'POST', url: '/api/export/authority', headers: { cookie: c }, payload });
const exportCount = async () => (await sql<{ n: number }>`SELECT count(*) AS n FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND action = 'export'`.execute(ctx.t.admin)).rows[0]!.n;
const completedCount = async () => (await sql<{ n: number }>`SELECT count(*) AS n FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND action = 'export_completed'`.execute(ctx.t.admin)).rows[0]!.n;
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
// Giải nén gói zip vào thư mục tạm, trả thư mục chứa các tệp.
const unzip = (buf: Buffer) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kt-export-')); const zip = path.join(dir, 'x.zip'); writeFileSync(zip, buf);
  execSync(`unzip -q "${zip}" -d "${dir}/out"`); return { dir, out: `${dir}/out` };
};
const userCookie = async (roleCode: string, sensitiveFlags: string[]) => {
  const username = `xk_${roleCode}_${sensitiveFlags.length}_${Date.now()}`;
  const made = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username, fullName: 'X', password: 'Matkhau1!', roleCode, sensitiveFlags } });
  expect(made.statusCode, made.body).toBe(201);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'Matkhau1!' } });
  return `sid=${login.cookies.find((x) => x.name === 'sid')!.value}`;
};
const pkt = (date: string, i: number, autoPost = true) => ctx.app.inject({ method: 'POST', url: '/api/vouchers', headers: { cookie }, payload: { voucherType: 'PKT', postingDate: date, documentDate: date, description: `CT ${i}`, autoPost, lines: [{ accountCode: '6422', debit: String(i * 1000) }, { accountCode: '1111', credit: String(i * 1000) }] } });

beforeAll(async () => {
  ctx = await createTestApp(); ({ cookie, tenantId } = await bootstrapTenant(ctx, { code: `EX${Date.now()}` }));
  const fy = (fiscalYear: number, regime: string) => ctx.app.inject({ method: 'POST', url: '/api/fiscal-years', headers: { cookie }, payload: { fiscalYear, dateFrom: `${fiscalYear}-01-01`, months: 12, regime } });
  expect((await fy(2026, 'TT133')).statusCode).toBe(201);
  expect((await fy(2027, 'TT200')).statusCode).toBe(201); // hệ tài khoản thứ hai trong cùng công ty
  await ctx.app.inject({ method: 'POST', url: '/api/catalogs/party', headers: { cookie }, payload: { code: 'KH001', name: 'Công ty "A"; B', is_customer: true } });
  for (let i = 1; i <= 3; i++) expect((await pkt(`2026-01-0${i}`, i)).statusCode).toBe(201);
  expect((await pkt('2026-02-05', 4)).statusCode).toBe(201); // ngoài khoảng xuất
  expect((await pkt('2026-01-09', 5, false)).statusCode).toBe(201); // nháp: không xuất
});
afterAll(async () => { await ctx.close(); });

describe('toCsv', () => {
  it('BOM, phân cách ;, bọc nháy kép khi có ; " xuống dòng \\n hoặc \\r, null thành ô rỗng, số giữ nguyên', () => {
    expect(toCsv([{ a: 'x;y', b: 'nói "hi"', c: 'd1\nd2', d: 'd1\rd2', e: null, f: 5, g: '1500000' }], ['a', 'b', 'c', 'd', 'e', 'f', 'g']))
      .toBe('\ufeffa;b;c;d;e;f;g\n"x;y";"nói ""hi""";"d1\nd2";"d1\rd2";;5;1500000\n');
    expect(toCsv([], ['a', 'b'])).toBe('\ufeffa;b\n');
  });
});

describe('xuất dữ liệu cho cơ quan thẩm quyền', () => {
  it('gói zip đủ tệp, CSV đúng số dòng, băm khớp, có audit', async () => {
    const r = await post(exportBody);
    expect(r.statusCode, r.body).toBe(200); expect(r.headers['content-type']).toBe('application/zip');
    expect(r.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('xuat-du-lieu-2026-01-01-2026-01-31.zip')}`);
    const { dir, out } = unzip(r.rawPayload); let manifestSha = '';
    try {
      const files = readdirSync(out);
      expect(files).toEqual(expect.arrayContaining(['README.txt', 'chung_tu.csv', 'dong_chung_tu.csv', 'he_thong_tai_khoan.csv', 'doi_tuong.csv', 'ky_ke_toan.csv', 'nhat_ky_kiem_toan.csv', 'so_nhat_ky_chung.pdf', 'so_cai.pdf', 'bang_can_doi_so_phat_sinh.pdf', 'MANIFEST.sha256']));
      expect(files).not.toContain('B01.pdf'); // chưa có định nghĩa báo cáo thì bỏ qua
      const ct = readFileSync(`${out}/chung_tu.csv`, 'utf8'); expect(ct.charCodeAt(0)).toBe(0xfeff); expect(ct.trim().split('\n')).toHaveLength(4);
      const lines = readFileSync(`${out}/dong_chung_tu.csv`, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(7); // 3 chứng từ trong kỳ x 2 dòng, không nháp, không chứng từ tháng 2
      expect(lines[0]).toContain(';voucher_no;state;line_no;'); expect(lines.slice(1).map((l) => l.split(';')[2])).toEqual(Array(6).fill('posted')); // mỗi dòng mang trạng thái chứng từ
      for (const f of files.filter((x) => x.endsWith('.pdf'))) expect(readFileSync(`${out}/${f}`).subarray(0, 4).toString()).toBe('%PDF');
      const manifest = readFileSync(`${out}/MANIFEST.sha256`, 'utf8').trim().split('\n');
      expect(manifest.map((l) => l.split(/\s+/)[1]).sort()).toEqual(files.filter((f) => f !== 'MANIFEST.sha256').sort());
      for (const line of manifest) {
        const [hash, name] = line.split(/\s+/); expect(createHash('sha256').update(readFileSync(`${out}/${name}`)).digest('hex')).toBe(hash);
      }
      expect(execSync('shasum -a 256 -c MANIFEST.sha256', { cwd: out }).toString()).toContain('README.txt: OK');
      const readme = readFileSync(`${out}/README.txt`, 'utf8');
      expect(readme).toContain(`Công ty EX`); expect(readme).toContain('2026-01-01 đến 2026-01-31'); expect(readme).toContain('giờ Việt Nam'); expect(readme).not.toContain('BỎ KHỎI GÓI'); // không PDF nào bị bỏ thì không có mục này
      manifestSha = sha256(readFileSync(`${out}/MANIFEST.sha256`));
      expect(readFileSync(`${out}/doi_tuong.csv`, 'utf8')).toContain('KH001;"Công ty ""A""; B"');
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(await exportCount()).toBe(1);
    const ev = await sql<{ after: { from: string; to: string }; entity: string; entity_id: string }>`SELECT entity, entity_id, after FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND action = 'export'`.execute(ctx.t.admin);
    expect(ev.rows[0]).toMatchObject({ entity: 'tenant', entity_id: tenantId, after: exportBody });
    // Dòng thứ hai ghi sau khi zip dựng xong: khoảng kỳ cùng băm của MANIFEST.sha256 và của chính tệp zip trả về.
    const done = await sql<{ after: object; entity: string; entity_id: string }>`SELECT entity, entity_id, after FROM audit_event WHERE tenant_id = ${tenantId}::uuid AND action = 'export_completed'`.execute(ctx.t.admin);
    expect(done.rows).toHaveLength(1);
    expect(done.rows[0]).toMatchObject({ entity: 'tenant', entity_id: tenantId, after: { ...exportBody, manifestSha256: manifestSha, zipSha256: sha256(r.rawPayload) } });
  });

  it('có B01 khi công ty đã định nghĩa; hệ tài khoản liệt kê đủ mọi hệ; nhật ký kiểm toán chỉ trong khoảng kỳ; kỳ kế toán có hash_tail', async () => {
    const def = await ctx.app.inject({ method: 'PUT', url: '/api/report-defs/B01', headers: { cookie }, payload: { regime: 'TT133', lines: [
      { lineCode: '100', label: 'A. Tài sản', parentLineCode: null, source: 'lines', side: 'net_debit', formula: null, isBold: true },
      { lineCode: '111', label: 'Tiền', parentLineCode: '100', source: 'balance', side: 'net_debit', formula: '111+112' }] } });
    expect(def.statusCode, def.body).toBe(200);
    const probe = (ts: string, action: string) => sql`INSERT INTO audit_event(tenant_id, ts, action, entity, entity_id, after) VALUES (${tenantId}::uuid, ${ts}::timestamptz, ${action}, 'probe', 'p', '{"k":"v"}'::jsonb)`.execute(ctx.t.admin);
    await probe('2026-01-15 10:00:00+00', 'probe_trong_ky'); await probe('2026-03-01 10:00:00+00', 'probe_ngoai_ky');
    const before = await exportCount();
    const r = await post(exportBody); expect(r.statusCode, r.body).toBe(200);
    const { dir, out } = unzip(r.rawPayload);
    try {
      expect(readdirSync(out)).toContain('B01.pdf'); expect(readFileSync(`${out}/B01.pdf`).subarray(0, 4).toString()).toBe('%PDF');
      const csvLines = (f: string) => readFileSync(`${out}/${f}`, 'utf8').split('\n').slice(0, -1); // không trim: trim() cũng cắt mất BOM
      const accounts = csvLines('he_thong_tai_khoan.csv');
      expect(accounts[0]).toBe('\ufeffregime;code;name;is_group;root_type;normal_balance;subledger_kind;track_currency;is_active');
      expect(new Set(accounts.slice(1).map((l) => l.split(';')[0]))).toEqual(new Set(['TT133', 'TT200']));
      const audit = readFileSync(`${out}/nhat_ky_kiem_toan.csv`, 'utf8');
      expect(audit).toContain('probe_trong_ky'); expect(audit).not.toContain('probe_ngoai_ky'); expect(audit).toContain('"{""k"": ""v""}"'); // jsonb in dạng chữ, có nháy kép nên được bọc
      const periods = csvLines('ky_ke_toan.csv');
      expect(periods[0]).toBe('\ufefffiscal_year;period_no;date_from;date_to;regime;status;hash_tail;locked_at'); expect(periods.length).toBeGreaterThan(12);
      expect(readFileSync(`${out}/chung_tu.csv`, 'utf8').split('\n')[0]).toContain(';source_doc_type;source_doc_id;'); expect(readFileSync(`${out}/chung_tu.csv`, 'utf8').split('\n')[0]).toContain(';row_hash');
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(await exportCount()).toBe(before + 1); // mỗi lần xuất một dòng audit; dòng của lần này không nằm trong gói của chính nó
  });

  it('nhật ký kiểm toán tính khoảng kỳ theo giờ Việt Nam: từ 00:00 ngày bắt đầu đến 23:59:59 ngày kết thúc', async () => {
    const probe = (ts: string, action: string) => sql`INSERT INTO audit_event(tenant_id, ts, action, entity, entity_id) VALUES (${tenantId}::uuid, ${ts}::timestamptz, ${action}, 'probe', 'p')`.execute(ctx.t.admin);
    await probe('2025-12-31 16:59:59+00', 'bien_truoc'); // 23:59:59 ngày 31/12 giờ Việt Nam: ngoài
    await probe('2025-12-31 17:00:00+00', 'bien_dau'); // 00:00:00 ngày 01/01: trong
    await probe('2026-01-31 16:59:59+00', 'bien_cuoi'); // 23:59:59 ngày 31/01: trong
    await probe('2026-01-31 17:00:00+00', 'bien_sau'); // 00:00:00 ngày 01/02: ngoài
    const r = await post(exportBody); expect(r.statusCode, r.body).toBe(200);
    const { dir, out } = unzip(r.rawPayload);
    try {
      const audit = readFileSync(`${out}/nhat_ky_kiem_toan.csv`, 'utf8');
      expect(audit).toContain('bien_dau'); expect(audit).toContain('bien_cuoi'); expect(audit).not.toContain('bien_truoc'); expect(audit).not.toContain('bien_sau');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('chứng từ nháp đã hủy (cancelled): dòng vẫn có trong dong_chung_tu.csv kèm trạng thái, README nói rõ không thuộc sổ', async () => {
    const draft = (await pkt('2026-01-12', 6, false)).json().id as string;
    expect((await ctx.app.inject({ method: 'POST', url: `/api/vouchers/${draft}/discard`, headers: { cookie } })).statusCode).toBe(200);
    const r = await post(exportBody); expect(r.statusCode, r.body).toBe(200);
    const { dir, out } = unzip(r.rawPayload);
    try {
      const rowsOf = (f: string) => readFileSync(`${out}/${f}`, 'utf8').trim().split('\n').map((l) => l.split(';')).filter((c) => c[0] === draft);
      expect(rowsOf('dong_chung_tu.csv').map((c) => c[2])).toEqual(['cancelled', 'cancelled']);
      expect(rowsOf('chung_tu.csv').map((c) => c[6])).toEqual(['cancelled']);
      const readme = readFileSync(`${out}/README.txt`, 'utf8');
      expect(readme).toContain('đã hủy khi còn là nháp, không thuộc sổ kế toán'); expect(readme).not.toContain('chưa từng ghi sổ'); // chứng từ có thể từng ghi sổ rồi bỏ ghi sổ trước khi hủy
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('cần quyền export.authority và đủ ba cờ nhạy cảm (gói gồm Nhật ký chung và Sổ Cái); thiếu thì 403 và không ghi audit', async () => {
    const before = await exportCount();
    const noFlags = await post(exportBody, await userCookie('ketoan_truong', []));
    expect([noFlags.statusCode, noFlags.json().error.code]).toEqual([403, 'FORBIDDEN']); expect(noFlags.json().error.message).toContain('view_receivable');
    const twoFlags = await post(exportBody, await userCookie('ketoan_truong', ['view_receivable', 'view_payable']));
    expect(twoFlags.statusCode).toBe(403); expect(twoFlags.json().error.message).toContain('view_cost');
    const noPerm = await post(exportBody, await userCookie('ketoan_vien', ['view_receivable', 'view_payable', 'view_cost']));
    expect(noPerm.statusCode).toBe(403); expect(noPerm.json().error.message).toContain('export.authority');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/export/authority', payload: exportBody })).statusCode).toBe(401);
    expect(await exportCount()).toBe(before);
  });

  it('khoảng ngày sai: 400; năm tài chính chưa có: 404; không ghi audit', async () => {
    const before = await exportCount();
    expect((await post({ from: '2026-02-01', to: '2026-01-31' })).statusCode).toBe(400);
    expect((await post({ from: '2026-02-30', to: '2026-03-01' })).statusCode).toBe(400);
    const none = await post({ from: '1999-01-01', to: '1999-12-31' });
    expect([none.statusCode, none.json().error.code]).toEqual([404, 'PERIOD_NOT_FOUND']);
    expect(await exportCount()).toBe(before);
  });

  it('PDF vượt 40.000 dòng: bỏ riêng tệp đó, gói vẫn 200 kèm ghi chú trong README, vẫn ghi audit', async () => {
    const before = await exportCount(); const doneBefore = await completedCount();
    // Giả lập sổ vượt ngưỡng bằng chính hàm chặn thật (tạo hơn 40.000 dòng sổ trong kiểm thử là quá nặng); lần gọi đầu là Sổ Nhật ký chung.
    const real = await vi.importActual<typeof Html>('../src/modules/reporting/print/html.js');
    vi.mocked(assertPrintable).mockImplementationOnce(() => real.assertPrintable([{ rows: new Array(MAX_PRINT_ROWS + 1) } as unknown as ReportDoc]));
    const r = await post(exportBody); expect(r.statusCode, r.body).toBe(200); expect(r.headers['content-type']).toBe('application/zip');
    const { dir, out } = unzip(r.rawPayload);
    try {
      const files = readdirSync(out);
      expect(files).not.toContain('so_nhat_ky_chung.pdf'); expect(files).toEqual(expect.arrayContaining(['so_cai.pdf', 'bang_can_doi_so_phat_sinh.pdf', 'chung_tu.csv', 'MANIFEST.sha256'])); // CSV không bị giới hạn
      const readme = readFileSync(`${out}/README.txt`, 'utf8');
      expect(readme).toContain('BỎ KHỎI GÓI'); expect(readme).toContain('so_nhat_ky_chung.pdf: vượt 40.000 dòng, in theo từng phần'); expect(readme).not.toContain('so_cai.pdf: vượt');
      expect(readFileSync(`${out}/MANIFEST.sha256`, 'utf8')).not.toContain('so_nhat_ky_chung.pdf');
      expect(execSync('shasum -a 256 -c MANIFEST.sha256', { cwd: out }).toString()).toContain('README.txt: OK');
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(await exportCount()).toBe(before + 1); expect(await completedCount()).toBe(doneBefore + 1);
  });

  it('PDF là sổ của năm tài chính chứa ngày kết thúc, kể cả năm tài chính bắt đầu từ tháng 4; ngày kết thúc ngoài mọi kỳ thì 404', async () => {
    const { cookie: c } = await bootstrapTenant(ctx, { code: `EA${Date.now()}` });
    const api = (url: string, payload: object) => ctx.app.inject({ method: 'POST', url, headers: { cookie: c }, payload });
    expect((await api('/api/fiscal-years', { fiscalYear: 2026, dateFrom: '2026-04-01', months: 12, regime: 'TT133' })).statusCode).toBe(201); // năm 2026 chạy 01/04/2026 đến 31/03/2027
    for (const date of ['2026-05-10', '2027-02-10']) expect((await api('/api/vouchers', { voucherType: 'PKT', postingDate: date, documentDate: date, description: 'CT', autoPost: true, lines: [{ accountCode: '6422', debit: '1000' }, { accountCode: '1111', credit: '1000' }] })).statusCode).toBe(201);
    vi.mocked(assertPrintable).mockClear();
    const r = await post({ from: '2027-02-01', to: '2027-02-28' }, c); expect(r.statusCode, r.body).toBe(200); // lấy 2027 từ chuỗi ngày thì không có năm 2027: 404
    const journal = vi.mocked(assertPrintable).mock.calls[0]![0][0]!; // nhóm PDF đầu tiên: Sổ Nhật ký chung
    expect(journal.title).toBe('Sổ Nhật ký chung'); expect(journal.subtitle).toContain('01/04/2026'); expect(journal.subtitle).toContain('31/03/2027');
    expect(journal.rows.map((x) => x['description'])).toEqual(expect.arrayContaining(['CT'])); expect(journal.rows).toHaveLength(4); // cả hai chứng từ của năm 2026, không chỉ tháng 2/2027
    const { dir, out } = unzip(r.rawPayload);
    try { expect(readFileSync(`${out}/chung_tu.csv`, 'utf8').trim().split('\n')).toHaveLength(2); } finally { rmSync(dir, { recursive: true, force: true }); } // CSV chỉ tháng 2/2027
    const gap = await post({ from: '2026-03-01', to: '2026-03-31' }, c); // trước ngày bắt đầu năm tài chính
    expect([gap.statusCode, gap.json().error.code]).toEqual([404, 'PERIOD_NOT_FOUND']);
  });

  it('ghi dòng export_completed không được thì không trả tệp (500), dòng export đã ghi ở bước đọc vẫn còn', async () => {
    const before = await exportCount(); const doneBefore = await completedCount();
    try { // tạo cả hàm lẫn trigger trong try: CREATE TRIGGER hỏng giữa chừng cũng không để lại hàm cho các lần chạy sau
      await sql`CREATE OR REPLACE FUNCTION kt_test_fail_completed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'kt_test: ghi audit thất bại' USING ERRCODE = 'XX000'; END $$`.execute(ctx.t.admin);
      await sql.raw('DROP TRIGGER IF EXISTS kt_test_fail_completed ON audit_event').execute(ctx.t.admin);
      await sql.raw(`CREATE TRIGGER kt_test_fail_completed BEFORE INSERT ON audit_event FOR EACH ROW WHEN (NEW.action = 'export_completed' AND NEW.tenant_id = '${tenantId}') EXECUTE FUNCTION kt_test_fail_completed()`).execute(ctx.t.admin);
      const r = await post(exportBody);
      expect(r.statusCode).toBe(500); expect(r.headers['content-type']).not.toContain('zip'); expect(r.rawPayload.subarray(0, 2).toString()).not.toBe('PK');
    } finally {
      await sql.raw('DROP TRIGGER IF EXISTS kt_test_fail_completed ON audit_event').execute(ctx.t.admin);
      await sql.raw('DROP FUNCTION IF EXISTS kt_test_fail_completed()').execute(ctx.t.admin);
    }
    expect(await exportCount()).toBe(before + 1); expect(await completedCount()).toBe(doneBefore);
  });
});
