import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { setupTestDb, type TestDb } from '@kt/db/testing';
import { SCOPES } from '../src/modules/ext/apiKeys.js';

// GĐ7 gói 1 (review trục 5 #4, #5): rào chắn cho các migration GĐ7 mà không sửa tệp đã áp dụng (checksum bất biến).
let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); }, 120_000);
afterAll(async () => { await t?.close(); });

describe('rào chắn migration', () => {
  it('api_key_scopes_check liệt kê đúng các phạm vi của SCOPES (thêm phạm vi mới: migration mới DROP CONSTRAINT IF EXISTS rồi liệt kê lại đủ)', async () => {
    const def = (await sql<{ d: string }>`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'api_key_scopes_check'`.execute(t.admin)).rows[0]?.d ?? '';
    const listed = [...def.matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1]!);
    expect([...new Set(listed)].sort()).toEqual([...SCOPES].sort());
  });

  it('mọi khóa ngoại tổng hợp của bảng GĐ7 (ngân sách, phê duyệt, chi nhánh, chứng từ ghi sổ) có chỉ mục dẫn đầu bằng cột khóa ngoại', async () => {
    const tables = ['approval_flow', 'approval_flow_step', 'approval_request', 'approval_step_log', 'approval_attachment', 'budget', 'budget_line', 'budget_setting', 'ledger_voucher_set', 'ledger_voucher_set_item',
      'user_branch_scope', 'branch_consolidation_setting'];
    const r = await sql<{ t: string; c: string; cols: string }>`
      SELECT c.conrelid::regclass::text AS t, c.conname AS c, (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY (${tables}::text[]) AND cardinality(c.conkey) > 1
        AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indisvalid AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey)`.execute(t.admin);
    expect(r.rows, 'khóa ngoại thiếu chỉ mục dẫn đầu').toEqual([]);
  });
});
