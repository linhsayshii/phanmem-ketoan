import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { defaultNormalBalance, rootTypeOf, type Regime } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

export interface AccountDto { id: number; code: string; name: string; nameEn: string | null; parentId: number | null; isGroup: boolean; rootType: string; normalBalance: string; trackCurrency: boolean; subledgerKind: string | null; isActive: boolean }

const toDto = (a: { id: number; code: string; name: string; name_en: string | null; parent_id: number | null; is_group: boolean; root_type: string; normal_balance: string; track_currency: boolean; subledger_kind: string | null; is_active: boolean }): AccountDto =>
  ({ id: a.id, code: a.code, name: a.name, nameEn: a.name_en, parentId: a.parent_id, isGroup: a.is_group, rootType: a.root_type, normalBalance: a.normal_balance, trackCurrency: a.track_currency, subledgerKind: a.subledger_kind, isActive: a.is_active });

export async function listAccounts(trx: Transaction<Database>, regime: string): Promise<AccountDto[]> {
  return (await trx.selectFrom('account').selectAll().where('regime', '=', regime).orderBy('code').execute()).map(toDto);
}

export async function generateAccounts(trx: Transaction<Database>, tenantId: string, regime: Regime): Promise<number> {
  const existing = await trx.selectFrom('account').select('id').where('regime', '=', regime).limit(1).executeTakeFirst();
  if (existing) throw new AppError('ACCOUNTS_EXIST', `Công ty đã có hệ thống tài khoản ${regime}`, 409);
  const tpl = await trx.selectFrom('coa_template').selectAll().where('regime', '=', regime).orderBy(sql`length(code)`).orderBy('code').execute();
  if (tpl.length === 0) throw new AppError('COA_TEMPLATE_PENDING', `Mẫu hệ thống tài khoản ${regime} chưa có dữ liệu (chờ văn bản gốc)`, 409);
  const idByCode = new Map<string, number>();
  for (const t of tpl) {
    const r = await trx.insertInto('account').values({
      tenant_id: tenantId, regime, code: t.code, name: t.name, name_en: t.name_en, parent_id: t.parent_code ? idByCode.get(t.parent_code) ?? null : null,
      is_group: t.is_group, root_type: t.root_type, normal_balance: t.normal_balance, track_currency: t.track_currency, subledger_kind: t.subledger_kind,
    }).returning('id').executeTakeFirstOrThrow();
    idByCode.set(t.code, r.id);
  }
  return tpl.length;
}

export async function addSubAccount(trx: Transaction<Database>, tenantId: string, input: { regime: string; parentCode: string; code: string; name: string; nameEn?: string | undefined; normalBalance?: 'debit' | 'credit' | 'both' | undefined; trackCurrency?: boolean | undefined; subledgerKind?: string | null | undefined }): Promise<number> {
  const parent = await trx.selectFrom('account').selectAll().where('regime', '=', input.regime).where('code', '=', input.parentCode).executeTakeFirst();
  if (!parent) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản ${input.parentCode}`, 404);
  const r = await trx.insertInto('account').values({
    tenant_id: tenantId, regime: input.regime, code: input.code, name: input.name, name_en: input.nameEn ?? null, parent_id: parent.id,
    root_type: rootTypeOf(input.code), normal_balance: input.normalBalance ?? parent.normal_balance ?? defaultNormalBalance(input.code),
    track_currency: input.trackCurrency ?? parent.track_currency, subledger_kind: input.subledgerKind === undefined ? parent.subledger_kind : input.subledgerKind,
  }).returning('id').executeTakeFirstOrThrow();
  return r.id;
}

// Tài khoản và mọi con cháu theo parent_id (không dựa vào tiền tố mã: một tài khoản có thể là con trực tiếp của cấp xa hơn).
async function subtreeIds(trx: Transaction<Database>, rootId: number): Promise<number[]> {
  const r = await sql<{ id: number }>`WITH RECURSIVE sub AS (SELECT id FROM account WHERE id = ${rootId} UNION ALL SELECT a.id FROM account a JOIN sub ON a.parent_id = sub.id) SELECT id FROM sub`.execute(trx);
  return r.rows.map((x) => x.id);
}

// Sau khi đổi mã hàng loạt (trigger tiền tố đang tắt): bật lại rồi "chạm" cột code của các dòng đã đổi để trigger kiểm tra tiền tố với cha.
async function revalidateTree(trx: Transaction<Database>, ids: number[]): Promise<void> {
  await sql`SELECT set_config('app.bulk_rename', 'off', true)`.execute(trx);
  await sql`UPDATE account SET code = code WHERE id = ANY(${ids})`.execute(trx);
}

export async function renameAccount(trx: Transaction<Database>, _tenantId: string, input: { regime: string; oldCode: string; newCode: string }): Promise<void> {
  const acc = await trx.selectFrom('account').select('id').where('regime', '=', input.regime).where('code', '=', input.oldCode).executeTakeFirst();
  if (!acc) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản ${input.oldCode}`, 404);
  if (!/^\d{1,8}$/.test(input.newCode)) throw new AppError('ACCOUNT_CODE_INVALID', 'Mã phải là 1–8 chữ số', 400);
  // Đổi cả cây (tài khoản và mọi tài khoản con) cùng một tiền tố; trigger tiền tố được tạm bỏ qua bằng biến phiên trong transaction này.
  const ids = await subtreeIds(trx, acc.id);
  await sql`SELECT set_config('app.bulk_rename', 'on', true)`.execute(trx);
  await sql`UPDATE account SET code = ${input.newCode} || substr(code, ${input.oldCode.length + 1}) WHERE id = ANY(${ids})`.execute(trx);
  await revalidateTree(trx, ids);
}

export async function mergeAccounts(trx: Transaction<Database>, _tenantId: string, input: { regime: string; sourceCode: string; targetCode: string }): Promise<void> {
  const src = await trx.selectFrom('account').selectAll().where('regime', '=', input.regime).where('code', '=', input.sourceCode).executeTakeFirst();
  const dst = await trx.selectFrom('account').selectAll().where('regime', '=', input.regime).where('code', '=', input.targetCode).executeTakeFirst();
  if (!src || !dst) throw new AppError('ACCOUNT_NOT_FOUND', 'Không có tài khoản nguồn hoặc đích', 404);
  const tree = await subtreeIds(trx, src.id);
  if (tree.includes(dst.id)) throw new AppError('ACCOUNT_MERGE_INVALID', 'Không ghép tài khoản vào chính nó hoặc vào tài khoản con của nó', 409);
  if (src.root_type !== dst.root_type) throw new AppError('ACCOUNT_ROOT_MISMATCH', 'Hai tài khoản khác loại', 409);
  // Cả cây dưới nguồn chuyển sang đích với mã đổi tiền tố; con trực tiếp đổi cha sang đích.
  const moved = tree.filter((id) => id !== src.id);
  if (moved.length) {
    await sql`SELECT set_config('app.bulk_rename', 'on', true)`.execute(trx);
    await sql`UPDATE account SET code = ${dst.code} || substr(code, ${src.code.length + 1}),
                parent_id = CASE WHEN parent_id = ${src.id} THEN ${dst.id} ELSE parent_id END
              WHERE id = ANY(${moved})`.execute(trx);
    // Đặt is_group cho đích trước: để trigger tự đặt trong lúc câu UPDATE nhiều dòng đang quét sẽ gặp lỗi 27000.
    await trx.updateTable('account').set({ is_group: true }).where('id', '=', dst.id).execute();
    await revalidateTree(trx, moved);
  }
  await trx.deleteFrom('account').where('id', '=', src.id).execute();
}
