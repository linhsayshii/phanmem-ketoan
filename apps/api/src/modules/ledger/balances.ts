import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { sensitiveDenial } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/balances', { preHandler: app.requirePermission('report.view'), schema: { querystring: z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), accountCode: z.string().optional(), byParty: z.enum(['true', 'false']).default('false') }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const tenantId = req.auth!.tenantId!; const byParty = req.query.byParty === 'true'; const { asOf } = req.query;
      const stale = (await trx.selectFrom('balance_stale').select('tenant_id').where('tenant_id', '=', tenantId).executeTakeFirst()) !== undefined;
      // Một công ty có thể giữ nhiều hệ tài khoản (mã trùng nhau giữa các chế độ): chỉ liệt kê tài khoản của chế độ kế toán của kỳ chứa asOf.
      // Kỳ chứa ngày trước, nếu không có thì kỳ bắt đầu gần nhất trước ngày; kỳ thường trước kỳ mở sổ (kỳ 0), cùng cách chọn kỳ với fn_balances_at.
      const period = await trx.selectFrom('fiscal_period').select('regime').where('date_from', '<=', asOf)
        .orderBy(sql`date_to < ${asOf}::date`).orderBy(sql`period_no = 0`).orderBy('fiscal_year', 'desc').orderBy('period_no', 'desc').executeTakeFirst();
      if (!period) return { rows: [], stale };
      // Cờ nhạy cảm như sổ sách: tài khoản công nợ/giá vốn người dùng không được xem thì bỏ khỏi kết quả; chỉ định mã trúng toàn tài khoản bị che thì 403.
      const accounts = await trx.selectFrom('account').select(['code', 'subledger_kind']).where('regime', '=', period.regime).execute();
      const denied = new Map(accounts.flatMap((a) => { const m = sensitiveDenial(req.auth!, a); return m ? [[a.code, m] as const] : []; }));
      if (req.query.accountCode) {
        const hit = accounts.filter((a) => a.code.startsWith(req.query.accountCode!));
        if (hit.length && hit.every((a) => denied.has(a.code))) throw new AppError('FORBIDDEN', denied.get(hit[0]!.code)!, 403);
      }
      const prefix = req.query.accountCode ? req.query.accountCode.replace(/[\\%_]/g, '\\$&') + '%' : null;
      const rows = await sql<{ accountCode: string; accountName: string; partyCode: string | null; partyName: string | null; currencyCode: string; debit: string; credit: string; debitCur: string; creditCur: string }>`
        SELECT a.code AS "accountCode", a.name AS "accountName", ${byParty ? sql`p.code` : sql`NULL`} AS "partyCode", ${byParty ? sql`p.name` : sql`NULL`} AS "partyName", b.currency_code AS "currencyCode",
               ${byParty ? sql`sum(b.debit)` : sql`greatest(sum(b.debit - b.credit), 0)`}::text AS debit, ${byParty ? sql`sum(b.credit)` : sql`greatest(-sum(b.debit - b.credit), 0)`}::text AS credit,
               ${byParty ? sql`sum(b.debit_cur)` : sql`greatest(sum(b.debit_cur - b.credit_cur), 0)`}::text AS "debitCur", ${byParty ? sql`sum(b.credit_cur)` : sql`greatest(-sum(b.debit_cur - b.credit_cur), 0)`}::text AS "creditCur"
        FROM fn_balances_at(${tenantId}::uuid, ${asOf}::date) b JOIN account a ON a.id = b.account_id AND a.regime = ${period.regime} LEFT JOIN party p ON p.id = b.party_id
        WHERE ${prefix ? sql`a.code LIKE ${prefix}` : sql`true`}
        GROUP BY a.code, a.name, b.currency_code ${byParty ? sql`, p.code, p.name` : sql``}
        ${byParty ? sql`` : sql`HAVING sum(b.debit - b.credit) <> 0 OR sum(b.debit_cur - b.credit_cur) <> 0`}
        ORDER BY a.code, 3, b.currency_code`.execute(trx);
      return { rows: rows.rows.filter((r) => !denied.has(r.accountCode)), stale };
    }, READ_SNAPSHOT));
  app.post('/api/balances/recompute', { preHandler: app.requirePermission('report.view') }, async (req) =>
    app.withTenant(req, async (trx) => ({ periods: (await sql<{ n: number }>`SELECT recompute_balances(${req.auth!.tenantId!}::uuid) AS n`.execute(trx)).rows[0]!.n })));
};
export default routes;
