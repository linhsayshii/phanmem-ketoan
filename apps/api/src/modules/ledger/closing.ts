import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { loadDefaultClosingSteps } from '@kt/coa-data';
import { VND_AMOUNT_MSG, VND_AMOUNT_RE, type Regime } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { notifyRecompute } from './notifyRecompute.js';
import { dateIso } from './vouchers.service.js';

export const stepInput = z.object({ id: z.string().uuid().optional(), stepOrder: z.number().int(), name: z.string().min(1), mode: z.enum(['transfer', 'allocate']),
  fromAccounts: z.array(z.string().min(1)).min(1), toAccount: z.string().nullable().optional(), keepBalance: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG).default('0'),
  byDimension: z.enum(['project']).nullable().optional(),
  ratioSource: z.object({ ratios: z.array(z.object({ account: z.string().min(1), percent: z.string().regex(/^\d+(\.\d+)?$/) })) }).nullable().optional(),
  runAt: z.enum(['period_end', 'next_year_start']).default('period_end'), isActive: z.boolean().default(true) });

type Trx = Transaction<Database>;

// Thay sơ đồ của riêng chế độ này bằng mẫu (sơ đồ chế độ khác giữ nguyên). Nhật ký chạy (closing_run) không mất: step_id về NULL.
export async function loadClosingTemplate(trx: Trx, tenantId: string, regime: Regime): Promise<number> {
  await trx.deleteFrom('closing_step').where('regime', '=', regime).execute();
  const tpl = loadDefaultClosingSteps(regime);
  for (const s of tpl) await trx.insertInto('closing_step').values({ tenant_id: tenantId, regime, step_order: s.stepOrder, name: s.name, mode: s.mode, from_accounts: s.fromAccounts, to_account: s.toAccount,
    keep_balance: s.keepBalance ?? '0', by_dimension: s.byDimension ?? null, ratio_source: s.ratioSource ? JSON.stringify(s.ratioSource) : null, run_at: s.runAt }).execute();
  return tpl.length;
}
// Chế độ của sơ đồ cần dùng: nêu rõ, hoặc theo kỳ chứa ngày (mặc định hôm nay, giờ Việt Nam), không có thì theo năm gần nhất.
export async function resolveRegime(trx: Trx, regime?: string, date?: string): Promise<Regime> {
  if (regime) return regime as Regime;
  const day = date ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
  const year = await trx.selectFrom('fiscal_period').select('regime').where('period_no', '>', 0)
    .orderBy(sql`(date_from <= ${day}::date and date_to >= ${day}::date)`, 'desc').orderBy('date_to', 'desc').executeTakeFirst();
  if (!year) throw new AppError('NO_FISCAL_YEAR', 'Chưa có năm tài chính: tạo năm tài chính trước khi thao tác với các bước kết chuyển', 409);
  return year.regime as Regime;
}
export async function listSteps(trx: Trx, regime: Regime) {
  return (await trx.selectFrom('closing_step').selectAll().where('regime', '=', regime).orderBy('step_order').execute()).map((s) => ({ id: s.id, regime: s.regime, stepOrder: s.step_order, name: s.name, mode: s.mode, fromAccounts: s.from_accounts, toAccount: s.to_account,
    keepBalance: s.keep_balance, byDimension: s.by_dimension, ratioSource: s.ratio_source, runAt: s.run_at, isActive: s.is_active }));
}
const ids = async (trx: Trx, fn: 'run_closing_step' | 'rerun_closing_step', tenantId: string, stepId: string, date: string) =>
  (await sql<{ ids: string[] }>`SELECT ${sql.id(fn)}(${tenantId}::uuid, ${stepId}::uuid, ${date}::date) AS ids`.execute(trx)).rows[0]!.ids;
export const runStep = (trx: Trx, tenantId: string, stepId: string, date: string) => ids(trx, 'run_closing_step', tenantId, stepId, date);
export const rerunStep = (trx: Trx, tenantId: string, stepId: string, date: string) => ids(trx, 'rerun_closing_step', tenantId, stepId, date);

// Chạy lại một bước chỉ đảo và chạy lại đúng bước đó. Các bước đang dùng ở sau (theo thứ tự) đã chạy xong tại cùng ngày vẫn giữ số cũ, không còn khớp số dư mới:
// trả tên chúng để màn hình nhắc chạy lại.
export async function laterStepsDone(trx: Trx, stepId: string, date: string): Promise<string[]> {
  const cur = await trx.selectFrom('closing_step').select(['step_order', 'regime']).where('id', '=', stepId).executeTakeFirst();
  if (!cur) return [];
  return (await trx.selectFrom('closing_step as s').select('s.name').where('s.is_active', '=', true).where('s.regime', '=', cur.regime).where('s.step_order', '>', cur.step_order)
    .where((eb) => eb.exists(eb.selectFrom('closing_run as r').select('r.id').whereRef('r.step_id', '=', 's.id').where('r.posting_date', '=', date).where('r.status', '=', 'done')))
    .orderBy('s.step_order').execute()).map((s) => s.name);
}

// Màn hình nêu chế độ hoặc một ngày (ngày kết chuyển) để chọn sơ đồ; không nêu thì theo năm chứa hôm nay.
const regimeSel = { regime: z.enum(['TT99', 'TT133', 'TT200', 'TT58']).optional(), date: dateIso.optional() };
const runBody = z.object({ stepId: z.string().uuid(), postingDate: dateIso });

const routes: FastifyPluginAsyncZod = async (app) => {
  // Chưa có năm tài chính thì chưa có sơ đồ nào để hiện: trả danh sách rỗng thay vì lỗi.
  app.get('/api/closing/steps', { preHandler: app.requirePermission('closing_step.view'), schema: { querystring: z.object(regimeSel) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const regime = await resolveRegime(trx, req.query.regime, req.query.date).catch((e: unknown) => { if ((e as AppError).code === 'NO_FISCAL_YEAR') return null; throw e; });
      return regime ? listSteps(trx, regime) : [];
    }));
  app.put('/api/closing/steps', { preHandler: app.requirePermission('closing_step.update'), schema: { body: z.object({ steps: z.array(stepInput), ...regimeSel }) } }, async (req) => {
    const tenantId = req.auth!.tenantId!;
    await app.withTenant(req, async (trx) => {
      const regime = await resolveRegime(trx, req.body.regime, req.body.date);
      const keep = req.body.steps.flatMap((s) => (s.id ? [s.id] : []));
      const own = trx.deleteFrom('closing_step').where('regime', '=', regime);
      await (keep.length ? own.where('id', 'not in', keep) : own).execute();
      for (const s of req.body.steps) {
        const row = { tenant_id: tenantId, regime, step_order: s.stepOrder, name: s.name, mode: s.mode, from_accounts: s.fromAccounts, to_account: s.toAccount ?? null, keep_balance: s.keepBalance, by_dimension: s.byDimension ?? null,
          ratio_source: s.ratioSource ? JSON.stringify(s.ratioSource) : null, run_at: s.runAt, is_active: s.isActive };
        if (!s.id) { await trx.insertInto('closing_step').values(row).execute(); continue; }
        // Mã bước cũ (màn hình mở từ trước khi nạp lại mẫu) hoặc của chế độ khác không còn: dừng, không để sơ đồ bị xóa sạch rồi lưu rỗng.
        const r = await trx.updateTable('closing_step').set(row).where('id', '=', s.id).where('regime', '=', regime).executeTakeFirst();
        if (r.numUpdatedRows === 0n) throw new AppError('CLOSING_STEP_STALE', 'Sơ đồ đã thay đổi, hãy tải lại trang', 409);
      }
    });
    return { ok: true };
  });
  // Nạp lại mẫu của một chế độ (nêu regime hoặc date, mặc định theo năm chứa hôm nay); sơ đồ các chế độ khác không đổi.
  app.post('/api/closing/steps/reload', { preHandler: app.requirePermission('closing_step.update'), schema: { body: z.object(regimeSel).nullish() } }, async (req) => {
    const count = await app.withTenant(req, async (trx) => loadClosingTemplate(trx, req.auth!.tenantId!, await resolveRegime(trx, req.body?.regime, req.body?.date)));
    return { count };
  });

  app.post('/api/closing/run', { preHandler: app.requirePermission('closing.run'), schema: { body: runBody } }, async (req) => {
    const tenantId = req.auth!.tenantId!;
    const voucherIds = await app.withTenant(req, (trx) => runStep(trx, tenantId, req.body.stepId, req.body.postingDate));
    notifyRecompute(app, tenantId);
    return { voucherIds };
  });
  app.post('/api/closing/rerun', { preHandler: app.requirePermission('closing.run'), schema: { body: runBody } }, async (req) => {
    const tenantId = req.auth!.tenantId!;
    const out = await app.withTenant(req, async (trx) => ({ voucherIds: await rerunStep(trx, tenantId, req.body.stepId, req.body.postingDate), laterStepsDone: await laterStepsDone(trx, req.body.stepId, req.body.postingDate) }));
    notifyRecompute(app, tenantId);
    return out;
  });
  // Mỗi bước một giao dịch, dừng ở lỗi đầu tiên: các bước đã chạy giữ nguyên (xem nhật ký chạy), chạy lại thì bước xong trước đó không có gì để kết chuyển nữa.
  app.post('/api/closing/run-all', { preHandler: app.requirePermission('closing.run'), schema: { body: z.object({ postingDate: dateIso }) } }, async (req) => {
    const tenantId = req.auth!.tenantId!;
    const steps = (await app.withTenant(req, async (trx) => listSteps(trx, await resolveRegime(trx, undefined, req.body.postingDate)))).filter((s) => s.isActive && s.runAt === 'period_end');
    const out: { stepId: string; voucherIds: string[] }[] = [];
    try { for (const s of steps) out.push({ stepId: s.id, voucherIds: await app.withTenant(req, (trx) => runStep(trx, tenantId, s.id, req.body.postingDate)) }); }
    finally { if (out.length) notifyRecompute(app, tenantId); }
    return { steps: out };
  });
  app.get('/api/closing/runs', { preHandler: app.requirePermission('closing_step.view'), schema: { querystring: z.object({ year: z.coerce.number().int().optional() }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      let q = trx.selectFrom('closing_run as r').leftJoin('closing_step as s', 's.id', 'r.step_id').innerJoin('voucher as v', 'v.id', 'r.voucher_id')
        .select(['r.id', sql<string>`coalesce(s.name, 'Bước đã xóa')`.as('stepName'), 'r.posting_date as postingDate', 'v.voucher_no as voucherNo', 'r.voucher_id as voucherId', 'r.status', 'r.created_at as createdAt']);
      if (req.query.year) q = q.where(sql<boolean>`extract(year from r.posting_date) = ${req.query.year}`);
      return q.orderBy('r.id', 'desc').execute();
    }));
};
export default routes;
