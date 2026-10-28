import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { READ_SNAPSHOT } from '@kt/db';
import { D } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { cashBalanceAt } from '../cash/books.js';
import { extAuthHook } from '../ext/auth.js';
import { evaluateFinancialReport } from '../reporting/financial.js';
import { isoDate, ordered, orderedMsg } from '../reporting/routes.js';
import { approveWithFiles } from './routes.js';
import { decisionInput, getRequest, listRequests, rejectInput, rejectRequest, type RequestDto } from './service.js';

const idParam = z.object({ id: z.string().uuid() });
const range = z.object({ from: isoDate, to: isoDate }).refine(ordered, orderedMsg);

// Xác thực: có Authorization thì phải là khóa API có phạm vi "mobile" (quyền = vai trò hiện hành ∩ phạm vi); không có thì dùng phiên cookie như web.
// Khóa API chỉ được đọc ở /api/ext/v1 và /api/mobile/v1, nên không thể dùng cho route quản trị.
const mobileAuth = (ext: ReturnType<typeof extAuthHook>) => async (req: FastifyRequest): Promise<void> => {
  if (req.headers.authorization !== undefined) {
    await ext(req);
    if (!req.apiKey!.scopes.includes('mobile')) throw new AppError('SCOPE_FORBIDDEN', 'Khóa API không có phạm vi mobile', 403);
    return;
  }
  if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Chưa đăng nhập', 401);
  if (!req.auth.tenantId) throw new AppError('NO_TENANT', 'Chưa chọn công ty', 409);
};
const need = (perm: string) => async (req: FastifyRequest): Promise<void> => {
  if (!req.auth!.permissions.has(perm)) throw new AppError('FORBIDDEN', `Thiếu quyền ${perm}`, 403);
};

// JSON gọn cho màn hình điện thoại.
const brief = (r: RequestDto) => ({
  id: r.id, requestNo: r.requestNo, kind: r.kind, kindLabel: r.kindLabel, requestDate: r.requestDate, requester: r.requesterName, payee: r.payeeName, reason: r.reason,
  amount: r.amount, currencyCode: r.currencyCode, amountCurrency: r.amountCurrency, state: r.state, step: r.currentStep, steps: r.steps.length, dueDate: r.dueDate,
});

const routes: FastifyPluginAsyncZod = async (app) => {
  const ext = extAuthHook(app);
  app.addHook('onRequest', mobileAuth(ext));
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Không có điểm cuối này' } }));
  const approve = { preHandler: need('approval_request.approve') };
  const report = { preHandler: need('report.view') };

  app.get('/me', async (req) => {
    const a = req.auth!;
    const pending = a.permissions.has('approval_request.approve') ? (await app.withTenant(req, (trx) => listRequests(trx, a, 'inbox'), READ_SNAPSHOT)).length : 0;
    return { username: a.username, tenantId: a.tenantId, via: req.apiKey ? 'api_key' : 'session', canApprove: a.permissions.has('approval_request.approve'), canViewReports: a.permissions.has('report.view'), pending };
  });

  app.get('/approvals', approve, async (req) => ({ items: (await app.withTenant(req, (trx) => listRequests(trx, req.auth!, 'inbox'), READ_SNAPSHOT)).map(brief) }));
  app.get('/approvals/:id', { ...approve, schema: { params: idParam } }, async (req) => {
    const r = await app.withTenant(req, (trx) => getRequest(trx, req.auth!, req.params.id), READ_SNAPSHOT);
    return { ...brief(r), partyName: r.partyName, payMethod: r.payMethod, canAct: r.canAct, rejectReason: r.rejectReason, voucherNo: r.voucherNo,
      approvals: r.log.map((l) => ({ step: l.stepNo, action: l.action, by: l.username, at: l.at, note: l.note })), attachments: r.attachments.length };
  });
  app.post('/approvals/:id/approve', { ...approve, schema: { params: idParam, body: decisionInput } }, async (req) => approveWithFiles(app, req, req.params.id, req.body.note ?? null));
  app.post('/approvals/:id/reject', { ...approve, schema: { params: idParam, body: rejectInput } }, async (req) => {
    await app.withTenant(req, (trx) => rejectRequest(trx, req.auth!, req.params.id, req.body.reason));
    return { state: 'rejected' };
  });

  // B01/B02 tóm tắt: các chỉ tiêu in đậm (tổng, nhóm chính) của báo cáo đầy đủ cùng kỳ.
  app.get('/reports/financial/:code', { ...report, schema: { params: z.object({ code: z.enum(['B01', 'B02']) }), querystring: range } }, async (req) => {
    const r = await app.withTenant(req, (trx) => evaluateFinancialReport(trx, req.auth!.tenantId!, { reportCode: req.params.code, from: req.query.from, to: req.query.to, comparePrevYear: false }), READ_SNAPSHOT);
    return { reportCode: r.reportCode, name: r.name, regime: r.regime, period: r.period, rows: r.rows.filter((x) => x.isBold).map((x) => ({ lineCode: x.lineCode, label: x.label, current: x.current, previous: x.previous })) };
  });

  // Số dư tiền tại ngày: tiền mặt (111), tiền gửi ngân hàng (112).
  app.get('/reports/cash', { ...report, schema: { querystring: z.object({ asOf: isoDate }) } }, async (req) =>
    app.withTenant(req, async (trx) => {
      const cash = (await cashBalanceAt(trx, { accountCode: '111', asOf: req.query.asOf })).balance;
      const bank = (await cashBalanceAt(trx, { accountCode: '112', asOf: req.query.asOf })).balance;
      return { asOf: req.query.asOf, cash, bank, total: D(cash).plus(bank).toFixed(0) };
    }, READ_SNAPSHOT));

  // Doanh thu, chi phí trong kỳ theo TK cấp 1 (loại 5, 7: Có − Nợ; loại 6, 8: Nợ − Có), bỏ bút toán kết chuyển. Giá vốn (632) chỉ hiện khi có view_cost.
  app.get('/reports/pnl', { ...report, schema: { querystring: range } }, async (req) => {
    const showCost = req.auth!.sensitive.has('view_cost');
    const rows = await app.withTenant(req, async (trx) => (await sql<{ code: string; name: string; amount: string }>`
      SELECT left(a.code, 3) AS code, min(g.name) AS name,
             sum(CASE WHEN left(a.code, 1) IN ('5', '7') THEN l.credit - l.debit ELSE l.debit - l.credit END)::text AS amount
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
      LEFT JOIN account g ON g.regime = a.regime AND g.code = left(a.code, 3)
      WHERE v.state IN ('posted', 'reversed') AND NOT v.is_closing AND l.posting_date BETWEEN ${req.query.from}::date AND ${req.query.to}::date AND left(a.code, 1) IN ('5', '6', '7', '8')
      GROUP BY left(a.code, 3) ORDER BY 1`.execute(trx)).rows, READ_SNAPSHOT);
    const pick = (digits: string[]) => rows.filter((r) => digits.includes(r.code[0]!) && (showCost || !r.code.startsWith('632')) && !D(r.amount).isZero()).map((r) => ({ accountCode: r.code, name: r.name, amount: D(r.amount).toFixed(0) }));
    const revenue = pick(['5', '7']); const expense = pick(['6', '8']);
    const total = (xs: { amount: string }[]) => xs.reduce((s, x) => s.plus(x.amount), D(0)).toFixed(0);
    return { from: req.query.from, to: req.query.to, revenue, expense, totalRevenue: total(revenue), totalExpense: total(expense), ...(showCost ? { profit: D(total(revenue)).minus(total(expense)).toFixed(0) } : { costHidden: true }) };
  });
};
export default routes;
