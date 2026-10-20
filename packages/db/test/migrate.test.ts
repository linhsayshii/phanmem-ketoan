import '../src/env.js';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { checksum, migrate } from '../src/migrate.js';

const adminUrl = process.env.DATABASE_ADMIN_URL!;

describe('migrate', () => {
  it('áp dụng migration một lần và ghi vào schema_migration', async () => {
    const first = await migrate(adminUrl);
    const second = await migrate(adminUrl);
    expect(second).toEqual([]);
    const pool = new pg.Pool({ connectionString: adminUrl });
    const r = await pool.query('SELECT name, checksum FROM schema_migration ORDER BY name');
    await pool.end();
    expect(r.rows.map((x) => x.name)).toEqual(expect.arrayContaining(['0001_nen_tang.sql']));
    expect(r.rows.every((x) => /^[0-9a-f]{64}$/.test(x.checksum))).toBe(true); // mọi dòng đều có checksum (dòng cũ được điền ở lần chạy đầu)
    expect(first.length + 0).toBeGreaterThanOrEqual(0);
  });
});

// Checksum: migration đã áp dụng là bất biến. Chạy trên cơ sở dữ liệu tạm với thư mục migration tạm để không đụng bảng schema_migration thật.
describe('migrate: checksum', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const dbName = `ketoan_mig_${randomBytes(4).toString('hex')}`;
  const url = (() => { const u = new URL(adminUrl); u.pathname = `/${dbName}`; return u.toString(); })();
  let dir: string; let pool: pg.Pool;
  const put = (name: string, body: string) => writeFileSync(path.join(dir, name), body);
  const stored = async () => Object.fromEntries((await pool.query('SELECT name, checksum FROM schema_migration')).rows.map((r) => [r.name, r.checksum]));

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`); await admin.end();
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(async () => {
    await pool.end();
    const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await admin.end();
  });
  afterEach(() => { delete process.env.MIGRATE_ALLOW_CHECKSUM_CHANGE; rmSync(dir, { recursive: true, force: true }); });
  const fresh = async () => { dir = mkdtempSync(path.join(tmpdir(), 'kt-mig-')); await pool.query('DROP TABLE IF EXISTS schema_migration, t1, t2'); };

  it('ghi sha256 của nội dung tệp khi áp dụng; chạy lại không đổi gì', async () => {
    await fresh(); put('0001_a.sql', 'CREATE TABLE t1(a int);');
    expect(await migrate(url, dir)).toEqual(['0001_a.sql']);
    expect(await stored()).toEqual({ '0001_a.sql': sha('CREATE TABLE t1(a int);') });
    expect(await migrate(url, dir)).toEqual([]);
  });

  it('tệp đã áp dụng bị sửa: báo lỗi nêu tên tệp và không áp dụng migration mới nào', async () => {
    await fresh(); put('0001_a.sql', 'CREATE TABLE t1(a int);');
    await migrate(url, dir);
    put('0001_a.sql', 'CREATE TABLE t1(a int, b int);'); put('0002_b.sql', 'CREATE TABLE t2(a int);');
    await expect(migrate(url, dir)).rejects.toThrow(/0001_a\.sql.*(sửa|checksum)/s);
    expect(Object.keys(await stored())).toEqual(['0001_a.sql']); // 0002 chưa chạy
    expect((await pool.query(`SELECT to_regclass('t2') AS t`)).rows[0].t).toBeNull();
  });

  it('checksum bỏ qua CRLF và BOM UTF-8, vẫn bằng sha256 của bản LF đã lưu', () => {
    const lf = 'CREATE TABLE t1(a int);\n-- dòng hai\n';
    expect(checksum(lf)).toBe(sha(lf));
    expect(checksum(lf.replace(/\n/g, '\r\n'))).toBe(sha(lf));
    expect(checksum('\uFEFF' + lf.replace(/\n/g, '\r\n'))).toBe(sha(lf));
  });

  it('áp dụng bản LF rồi checkout lại thành CRLF có BOM: không báo lỗi, không đổi checksum', async () => {
    await fresh(); put('0001_a.sql', 'CREATE TABLE t1(a int);\n');
    await migrate(url, dir);
    put('0001_a.sql', '\uFEFFCREATE TABLE t1(a int);\r\n');
    expect(await migrate(url, dir)).toEqual([]);
    expect(await stored()).toEqual({ '0001_a.sql': sha('CREATE TABLE t1(a int);\n') });
  });

  it('MIGRATE_ALLOW_CHECKSUM_CHANGE=1 chấp nhận tệp đã sửa, ghi checksum mới, rồi chạy tiếp migration mới', async () => {
    await fresh(); put('0001_a.sql', 'CREATE TABLE t1(a int);');
    await migrate(url, dir);
    put('0001_a.sql', 'CREATE TABLE t1(a int); -- chú thích\n'); put('0002_b.sql', 'CREATE TABLE t2(a int);');
    process.env.MIGRATE_ALLOW_CHECKSUM_CHANGE = '1';
    expect(await migrate(url, dir)).toEqual(['0002_b.sql']);
    delete process.env.MIGRATE_ALLOW_CHECKSUM_CHANGE;
    expect((await stored())['0001_a.sql']).toBe(sha('CREATE TABLE t1(a int); -- chú thích\n'));
    expect(await migrate(url, dir)).toEqual([]); // lần sau không cần cờ nữa
  });

  it('cơ sở dữ liệu cũ (bảng chưa có cột checksum hoặc checksum NULL): điền theo tệp hiện tại ở lần thấy đầu tiên, không báo lỗi', async () => {
    await fresh(); put('0001_a.sql', 'CREATE TABLE t1(a int);');
    await pool.query('CREATE TABLE schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'); // dạng trước khi có checksum
    await pool.query(`INSERT INTO schema_migration(name) VALUES ('0001_a.sql')`); await pool.query('CREATE TABLE t1(a int)');
    put('0001_a.sql', 'CREATE TABLE t1(a int); -- đã sửa trước khi có checksum\n');
    expect(await migrate(url, dir)).toEqual([]);
    expect(await stored()).toEqual({ '0001_a.sql': sha('CREATE TABLE t1(a int); -- đã sửa trước khi có checksum\n') });
    put('0001_a.sql', 'CREATE TABLE t1(a int); -- lại sửa\n');
    await expect(migrate(url, dir)).rejects.toThrow(/0001_a\.sql/); // từ đây trở đi bị bắt
  });
});
