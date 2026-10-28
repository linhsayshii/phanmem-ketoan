import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { ApprovalStepSnapshot, Database } from '@kt/db';
import { D, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import type { AuthCtx } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { createSystemVoucher, dateIso, fxRate, type SystemVoucherInput } from '../ledger/vouchers.service.js';
import { isSalaryCode } from '../payroll/accounts.js';
import { assertSensitive, regimeOf } from '../reporting/ledgers.js';

type Trx = Transaction<Database>;
type Auth = Pick<AuthCtx, 'tenantId' | 'userId' | 'permissions' | 'sensitive'>;

export const KINDS = ['payment', 'advance'] as const;
const KIND_LABEL = { payment: 'Đề nghị thanh toán', advance: 'Đề nghị tạm ứng' } as const;
const KIND_PREFIX = { payment: 'DNTT', advance: 'DNTU' } as const;
const DEFAULT_ACCOUNT = { payment: '331', advance: '141' } as const;

// ---- Quy trình ----
export const flowInput = z.object({
  kind: z.enum(KINDS), name: z.string().trim().min(1, 'Nhập tên quy trình').max(200),
  minAmount: z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG).default('0'), isActive: z.boolean().default(true),
  steps: z.array(z.object({ roleId: z.string().uuid().optional(), userId: z.string().uuid().optional() })
    .refine((s) => !!s.roleId !== !!s.userId, 'Mỗi bước chọn đúng một vai trò hoặc một người duyệt')).min(1, 'Quy trình cần ít nhất một bước').max(10),
});
export type FlowInput = z.infer<typeof flowInput>;

export async function listFlows(trx: Trx) {
  const flows = await trx.selectFrom('approval_flow').selectAll().orderBy('kind').orderBy('min_amount').execute();
  const steps = await trx.selectFrom('approval_flow_step as s').leftJoin('role as r', (j) => j.onRef('r.tenant_id', '=', 's.tenant_id').onRef('r.id', '=', 's.role_id'))
    .leftJoin('app_user as u', 'u.id', 's.user_id').select(['s.flow_id', 's.step_no', 's.role_id', 's.user_id', 'r.name as role_name', 'u.username']).orderBy('s.step_no').execute();
  return flows.map((f) => ({
    id: f.id, kind: f.kind, name: f.name, minAmount: D(f.min_amount).toFixed(0), isActive: f.is_active,
    steps: steps.filter((s) => s.flow_id === f.id).map((s) => ({ stepNo: s.step_no, roleId: s.role_id, roleName: s.role_name, userId: s.user_id, username: s.username })),
  }));
}

export async function saveFlow(trx: Trx, tenantId: string, id: number | null, input: FlowInput): Promise<{ id: number }> {
  const values = { kind: input.kind, name: input.name, min_amount: input.minAmount, is_active: input.isActive };
  let flowId = id;
  try {
    if (flowId === null) flowId = (await trx.insertInto('approval_flow').values({ tenant_id: tenantId, ...values }).returning('id').executeTakeFirstOrThrow()).id;
    else if (!Number((await trx.updateTable('approval_flow').set(values).where('id', '=', flowId).executeTakeFirst()).numUpdatedRows)) throw new AppError('APPROVAL_FLOW_NOT_FOUND', 'Không tìm thấy quy trình phê duyệt', 404);
  } catch (e) {
    if ((e as { constraint?: string }).constraint === 'approval_flow_threshold') throw new AppError('APPROVAL_FLOW_DUPLICATE', 'Đã có quy trình đang dùng cùng loại đề nghị và cùng hạn mức', 409);
    throw e;
  }
  await trx.deleteFrom('approval_flow_step').where('flow_id', '=', flowId).execute();
  try {
    await trx.insertInto('approval_flow_step').values(input.steps.map((s, i) => ({ tenant_id: tenantId, flow_id: flowId!, step_no: i + 1, role_id: s.roleId ?? null, user_id: s.userId ?? null }))).execute();
  } catch (e) {
    if ((e as { code?: string }).code === '23503') throw new AppError('LOOKUP_NOT_FOUND', 'Vai trò hoặc người duyệt không thuộc công ty này', 404);
    throw e;
  }
  return { id: flowId };
}

// ---- Đề nghị ----
const foreignAmount = /^\d{1,16}(\.\d{1,4})?$/;
export const requestInput = z.object({
  kind: z.enum(KINDS), requestDate: dateIso, partyCode: z.string().trim().min(1).max(50).nullable().optional(),
  payeeName: z.string().trim().min(1, 'Nhập người nhận tiền').max(200), reason: z.string().trim().min(1, 'Nhập lý do').max(1000),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).default('VND'), amountCurrency: z.string().regex(foreignAmount, 'Số tiền không hợp lệ').refine((s) => /[1-9]/.test(s), 'Số tiền phải lớn hơn 0'),
  fxRate: fxRate.nullable().optional(), accountCode: z.string().trim().regex(/^[0-9A-Za-z]{3,20}$/).nullable().optional(),
  payMethod: z.enum(['cash', 'bank']).default('cash'), bankAccountNo: z.string().trim().min(1).max(50).nullable().optional(), dueDate: dateIso.nullable().optional(),
});
export type RequestInput = z.infer<typeof requestInput>;

export interface RequestDto {
  id: string; kind: string; kindLabel: string; requestNo: string; requestDate: string; requesterId: string; requesterName: string; partyCode: string | null; partyName: string | null;
  payeeName: string; reason: string; currencyCode: string; amountCurrency: string; fxRate: string | null; amount: string; accountCode: string; payMethod: string; bankAccountNo: string | null;
  dueDate: string | null; state: string; steps: ApprovalStepSnapshot[]; currentStep: number; rejectReason: string | null; voucherId: string | null; voucherNo: string | null; voucherType: string | null;
  submittedAt: string | null; decidedAt: string | null; createdAt: string;
}
const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());

function baseQuery(trx: Trx) {
  return trx.selectFrom('approval_request as r').innerJoin('app_user as u', 'u.id', 'r.requester_id')
    .leftJoin('party as p', (j) => j.onRef('p.tenant_id', '=', 'r.tenant_id').onRef('p.id', '=', 'r.party_id'))
    .leftJoin('bank_account as b', (j) => j.onRef('b.tenant_id', '=', 'r.tenant_id').onRef('b.id', '=', 'r.bank_account_id'))
    .leftJoin('voucher as v', (j) => j.onRef('v.tenant_id', '=', 'r.tenant_id').onRef('v.id', '=', 'r.voucher_id'))
    .selectAll('r').select(['u.username', 'p.code as party_code', 'p.name as party_name', 'b.account_no', 'v.voucher_no', 'v.voucher_type']);
}
type Row = Awaited<ReturnType<ReturnType<typeof baseQuery>['executeTakeFirstOrThrow']>>;
const toDto = (r: Row): RequestDto => ({
  id: r.id, kind: r.kind, kindLabel: KIND_LABEL[r.kind as keyof typeof KIND_LABEL], requestNo: r.request_no, requestDate: r.request_date, requesterId: r.requester_id, requesterName: r.username,
  partyCode: r.party_code, partyName: r.party_name, payeeName: r.payee_name, reason: r.reason, currencyCode: r.currency_code, amountCurrency: D(r.amount_currency).toString(),
  fxRate: r.fx_rate === null ? null : D(r.fx_rate).toString(), amount: D(r.amount).toFixed(0), accountCode: r.account_code, payMethod: r.pay_method, bankAccountNo: r.account_no,
  dueDate: r.due_date, state: r.state, steps: r.steps, currentStep: r.current_step, rejectReason: r.reject_reason, voucherId: r.voucher_id, voucherNo: r.voucher_no, voucherType: r.voucher_type,
  submittedAt: iso(r.submitted_at), decidedAt: iso(r.decided_at), createdAt: iso(r.created_at)!,
});

// Cờ nhạy cảm theo TK Nợ của phiếu sẽ sinh (331 cần view_payable...); người đề nghị luôn xem được đề nghị của mình.
// Đề nghị chưa gắn chế độ tài khoản: cờ lương tính theo hợp ánh xạ của mọi chế độ (isSalaryCode với chế độ lạ): che nhiều hơn là lộ lương.
type SensAcc = { code: string; subledger_kind: string | null; salary: boolean };
const sensAcc = (code: string, kind: string | null): SensAcc => ({ code, subledger_kind: kind, salary: isSalaryCode('*', code) });
async function accountsOf(trx: Trx, codes: string[]) {
  if (!codes.length) return new Map<string, SensAcc>();
  const rows = await trx.selectFrom('account').select(['code', 'subledger_kind']).where('code', 'in', [...new Set(codes)]).execute();
  return new Map(rows.map((a) => [a.code, sensAcc(a.code, a.subledger_kind)]));
}
const visible = (auth: Auth, r: { requester_id: string; account_code: string }, accs: Map<string, SensAcc>) => {
  if (r.requester_id === auth.userId) return true;
  try { assertSensitive(auth, accs.get(r.account_code) ?? sensAcc(r.account_code, null)); return true; } catch { return false; }
};
async function assertVisible(trx: Trx, auth: Auth, r: { requester_id: string; account_code: string }) {
  if (r.requester_id === auth.userId) return;
  assertSensitive(auth, (await accountsOf(trx, [r.account_code])).get(r.account_code) ?? sensAcc(r.account_code, null));
}

async function resolveInput(trx: Trx, input: RequestInput) {
  const isVnd = input.currencyCode === 'VND';
  if (isVnd && !VND_AMOUNT_RE.test(input.amountCurrency)) throw new AppError('VALIDATION', VND_AMOUNT_MSG, 400);
  if (!isVnd && !input.fxRate) throw new AppError('VALIDATION', 'Đề nghị bằng ngoại tệ cần tỷ giá', 400);
  const amount = isVnd ? input.amountCurrency : D(input.amountCurrency).times(input.fxRate!).toFixed(0);
  if (!VND_AMOUNT_RE.test(amount) || !/[1-9]/.test(amount)) throw new AppError('VALIDATION', 'Số tiền quy đổi VND phải lớn hơn 0 và tối đa 16 chữ số', 400);
  const regime = await regimeOf(trx, { from: input.requestDate, to: input.requestDate });
  const accountCode = input.accountCode || DEFAULT_ACCOUNT[input.kind];
  const acc = await trx.selectFrom('account').select(['code', 'is_group', 'subledger_kind']).where('regime', '=', regime).where('code', '=', accountCode).where('is_active', '=', true).executeTakeFirst();
  if (!acc) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản ${accountCode} trong hệ thống tài khoản ${regime}`, 404);
  if (acc.is_group) throw new AppError('VALIDATION', `Tài khoản ${accountCode} là tài khoản tổng hợp, chọn tài khoản chi tiết`, 400);
  let partyId: string | null = null;
  if (input.partyCode) {
    const p = await trx.selectFrom('party').select('id').where('code', '=', input.partyCode).where('is_active', '=', true).executeTakeFirst();
    if (!p) throw new AppError('PARTY_NOT_FOUND', `Không có đối tượng mã "${input.partyCode}"`, 404);
    partyId = p.id;
  }
  if (!partyId && (acc.subledger_kind === 'payable' || acc.subledger_kind === 'receivable')) throw new AppError('VALIDATION', `Tài khoản ${accountCode} theo dõi công nợ: chọn đối tượng`, 400);
  let bankId: number | null = null;
  if (input.payMethod === 'bank') {
    if (!input.bankAccountNo) throw new AppError('VALIDATION', 'Chi bằng chuyển khoản: chọn tài khoản ngân hàng', 400);
    const b = await trx.selectFrom('bank_account').select('id').where('account_no', '=', input.bankAccountNo).where('is_active', '=', true).executeTakeFirst();
    if (!b) throw new AppError('BANK_ACCOUNT_NOT_FOUND', `Không có tài khoản ngân hàng "${input.bankAccountNo}"`, 404);
    bankId = b.id;
  }
  return {
    kind: input.kind, request_date: input.requestDate, party_id: partyId, payee_name: input.payeeName, reason: input.reason, currency_code: input.currencyCode,
    amount_currency: input.amountCurrency, fx_rate: isVnd ? null : input.fxRate!, amount, account_code: accountCode, pay_method: input.payMethod, bank_account_id: bankId, due_date: input.dueDate ?? null,
  };
}

export async function getRequestRow(trx: Trx, id: string, lock = false) {
  let q = trx.selectFrom('approval_request').selectAll().where('id', '=', id);
  if (lock) q = q.forUpdate();
  const r = await q.executeTakeFirst();
  if (!r) throw new AppError('APPROVAL_REQUEST_NOT_FOUND', 'Không tìm thấy đề nghị', 404);
  return r;
}

export async function getRequest(trx: Trx, auth: Auth, id: string) {
  const r = await baseQuery(trx).where('r.id', '=', id).executeTakeFirst();
  if (!r) throw new AppError('APPROVAL_REQUEST_NOT_FOUND', 'Không tìm thấy đề nghị', 404);
  // Người đề nghị, người được xem mọi đề nghị, người có quyền duyệt (để quyết định) mới thấy.
  if (r.requester_id !== auth.userId && !auth.permissions.has('approval_request.view') && !auth.permissions.has('approval_request.approve')) throw new AppError('APPROVAL_REQUEST_NOT_FOUND', 'Không tìm thấy đề nghị', 404);
  await assertVisible(trx, auth, r);
  const log = await trx.selectFrom('approval_step_log as l').innerJoin('app_user as u', 'u.id', 'l.actor_id')
    .select(['l.step_no', 'l.action', 'l.note', 'l.created_at', 'u.username']).where('l.request_id', '=', id).orderBy('l.id').execute();
  const attachments = await trx.selectFrom('approval_attachment').select(['id', 'file_name', 'mime', 'bytes', 'uploaded_at']).where('request_id', '=', id).orderBy('uploaded_at').execute();
  return {
    ...toDto(r), canAct: await canAct(trx, auth, r).then(() => true, () => false),
    log: log.map((l) => ({ stepNo: l.step_no, action: l.action, note: l.note, at: iso(l.created_at)!, username: l.username })),
    attachments: attachments.map((a) => ({ id: a.id, fileName: a.file_name, mime: a.mime, bytes: Number(a.bytes), uploadedAt: iso(a.uploaded_at)! })),
  };
}

async function nextNo(trx: Trx, tenantId: string, kind: keyof typeof KIND_PREFIX, date: string) {
  const prefix = `${KIND_PREFIX[kind]}-${date.slice(0, 4)}-`;
  await sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId + ':' + prefix}))`.execute(trx); // hai người lập cùng lúc không trùng số
  const last = await trx.selectFrom('approval_request').select('request_no').where('request_no', 'like', `${prefix}%`).orderBy('request_no', 'desc').limit(1).executeTakeFirst();
  return prefix + String((last ? Number(last.request_no.slice(prefix.length)) : 0) + 1).padStart(5, '0');
}

export async function createRequest(trx: Trx, auth: Auth, input: RequestInput): Promise<{ id: string; requestNo: string }> {
  const v = await resolveInput(trx, input);
  const requestNo = await nextNo(trx, auth.tenantId!, input.kind, input.requestDate);
  const r = await trx.insertInto('approval_request').values({ tenant_id: auth.tenantId!, request_no: requestNo, requester_id: auth.userId, ...v }).returning('id').executeTakeFirstOrThrow();
  return { id: r.id, requestNo };
}

const assertOwnDraft = (auth: Auth, r: { requester_id: string; state: string }) => {
  if (r.requester_id !== auth.userId) throw new AppError('FORBIDDEN', 'Chỉ người đề nghị được sửa, gửi duyệt hoặc hủy đề nghị', 403);
  if (r.state !== 'draft') throw new AppError('APPROVAL_NOT_DRAFT', 'Đề nghị đã gửi duyệt, không sửa được', 409);
};

export async function updateRequest(trx: Trx, auth: Auth, id: string, input: RequestInput) {
  const r = await getRequestRow(trx, id, true);
  assertOwnDraft(auth, r);
  if (r.kind !== input.kind) throw new AppError('VALIDATION', 'Không đổi loại đề nghị; hủy và lập đề nghị mới', 400);
  await trx.updateTable('approval_request').set(await resolveInput(trx, input)).where('id', '=', id).execute();
}

const log = (trx: Trx, tenantId: string, requestId: string, stepNo: number, action: string, actorId: string, note: string | null) =>
  trx.insertInto('approval_step_log').values({ tenant_id: tenantId, request_id: requestId, step_no: stepNo, action, actor_id: actorId, note }).execute();

export async function submitRequest(trx: Trx, auth: Auth, id: string) {
  const r = await getRequestRow(trx, id, true);
  assertOwnDraft(auth, r);
  const flow = await trx.selectFrom('approval_flow').select(['id', 'name']).where('kind', '=', r.kind).where('is_active', '=', true).where('min_amount', '<=', r.amount)
    .orderBy('min_amount', 'desc').limit(1).executeTakeFirst();
  if (!flow) throw new AppError('APPROVAL_FLOW_MISSING', `Chưa có quy trình phê duyệt cho ${KIND_LABEL[r.kind as keyof typeof KIND_LABEL].toLowerCase()} số tiền ${D(r.amount).toFixed(0)}; liên hệ quản trị để cấu hình`, 409);
  const steps = (await listFlows(trx)).find((f) => f.id === flow.id)!.steps;
  await trx.updateTable('approval_request').set({ state: 'submitted', flow_id: flow.id, steps: JSON.stringify(steps), current_step: 1, submitted_at: new Date().toISOString() }).where('id', '=', id).execute();
  await log(trx, auth.tenantId!, id, 0, 'submit', auth.userId, null);
}

export async function cancelRequest(trx: Trx, auth: Auth, id: string, note: string | null) {
  const r = await getRequestRow(trx, id, true);
  if (r.requester_id !== auth.userId) throw new AppError('FORBIDDEN', 'Chỉ người đề nghị được hủy đề nghị', 403);
  if (r.state !== 'draft' && r.state !== 'submitted') throw new AppError('APPROVAL_NOT_CANCELLABLE', 'Đề nghị đã duyệt, từ chối hoặc hủy: không hủy được', 409);
  await trx.updateTable('approval_request').set({ state: 'cancelled', decided_at: new Date().toISOString() }).where('id', '=', id).execute();
  await log(trx, auth.tenantId!, id, r.current_step, 'cancel', auth.userId, note);
}

// Người duyệt bước hiện tại: có quyền duyệt, không phải người đề nghị, đúng người hoặc đúng vai trò của bước, chưa duyệt bước nào trước đó của đề nghị (mỗi bước một người khác nhau).
async function canAct(trx: Trx, auth: Auth, r: { id: string; state: string; requester_id: string; steps: ApprovalStepSnapshot[]; current_step: number; account_code: string }) {
  if (r.state !== 'submitted') throw new AppError('APPROVAL_NOT_PENDING', 'Đề nghị không ở trạng thái chờ duyệt', 409);
  if (!auth.permissions.has('approval_request.approve')) throw new AppError('FORBIDDEN', 'Thiếu quyền approval_request.approve', 403);
  if (r.requester_id === auth.userId) throw new AppError('APPROVAL_SELF', 'Người đề nghị không tự duyệt đề nghị của mình', 403);
  const step = r.steps[r.current_step - 1]!;
  const me = await trx.selectFrom('tenant_user').select('role_id').where('user_id', '=', auth.userId).executeTakeFirstOrThrow();
  if (step.userId ? step.userId !== auth.userId : step.roleId !== me.role_id) throw new AppError('APPROVAL_WRONG_APPROVER', `Bước ${step.stepNo} do ${step.username ?? step.roleName ?? 'người khác'} duyệt`, 403);
  const acted = await trx.selectFrom('approval_step_log').select('id').where('request_id', '=', r.id).where('actor_id', '=', auth.userId).where('action', '=', 'approve').executeTakeFirst();
  if (acted) throw new AppError('APPROVAL_ALREADY_ACTED', 'Bạn đã duyệt một bước của đề nghị này; bước sau cần người khác duyệt', 403);
  await assertVisible(trx, auth, r);
  return step;
}

export const decisionInput = z.object({ note: z.string().trim().max(1000).optional() });
export const rejectInput = z.object({ reason: z.string().trim().min(1, 'Nhập lý do từ chối').max(1000) });

// Bước cuối duyệt xong: Phiếu chi (tiền mặt) / Giấy báo Nợ (chuyển khoản) nháp, Nợ TK của đề nghị / Có TK tiền; khóa idempotency theo đề nghị nên gọi lại không sinh thêm.
async function createPaymentVoucher(trx: Trx, auth: Auth, r: Awaited<ReturnType<typeof getRequestRow>>) {
  const regime = await regimeOf(trx, { from: r.request_date, to: r.request_date });
  const party = r.party_id ? await trx.selectFrom('party').select('code').where('id', '=', r.party_id).executeTakeFirstOrThrow() : null;
  const bank = r.bank_account_id ? await trx.selectFrom('bank_account').select(['account_no', 'gl_account_code']).where('id', '=', r.bank_account_id).executeTakeFirstOrThrow() : null;
  const isVnd = r.currency_code === 'VND';
  const cashAccount = bank?.gl_account_code ?? (isVnd ? '1111' : '1112');
  const purpose = r.account_code.startsWith('331') ? 'chi_tra_ncc' : r.account_code.startsWith('141') ? 'chi_tam_ung' : undefined;
  const amount = D(r.amount).toFixed(0);
  const cur = isVnd ? {} : { amountCurrency: D(r.amount_currency).toString() };
  const input: SystemVoucherInput = {
    voucherType: bank ? 'BN' : 'PC', postingDate: r.request_date, documentDate: r.request_date, currencyCode: r.currency_code, ...(isVnd ? {} : { fxRate: D(r.fx_rate!).toString() }),
    description: `${KIND_LABEL[r.kind as keyof typeof KIND_LABEL]} ${r.request_no}: ${r.reason}`.slice(0, 500), partyCode: party?.code ?? null, personName: r.payee_name,
    idempotencyKey: `apr:${r.id}`, ...(purpose && regime !== 'TT58' && { purpose }), ...(bank && { bankAccountNo: bank.account_no }),
    lines: [
      { accountCode: r.account_code, debit: amount, credit: '0', ...cur, partyCode: party?.code ?? null, description: r.reason.slice(0, 500) },
      { accountCode: cashAccount, debit: '0', credit: amount, ...cur, ...(bank && { bankAccountNo: bank.account_no }) },
    ],
  };
  return createSystemVoucher(trx, { tenantId: auth.tenantId!, userId: auth.userId }, input, { type: 'approval_request', id: r.id });
}

// Tệp đính kèm của đề nghị chép sang chứng từ gốc của phiếu (đường dẫn riêng: xóa ở phiếu không làm mất tệp của đề nghị). `written` để route xóa tệp khi giao dịch hỏng.
async function copyAttachments(trx: Trx, auth: Auth, requestId: string, voucherId: string, attachmentDir: string, written: string[]) {
  const atts = await trx.selectFrom('approval_attachment').selectAll().where('request_id', '=', requestId).orderBy('uploaded_at').execute();
  for (const a of atts) {
    const row = await trx.insertInto('voucher_attachment').values({ tenant_id: auth.tenantId!, voucher_id: voucherId, file_name: a.file_name, mime: a.mime, bytes: Number(a.bytes), storage_key: '', uploaded_by: a.uploaded_by })
      .returning('id').executeTakeFirstOrThrow();
    const key = path.join(attachmentDir, auth.tenantId!, voucherId, row.id);
    written.push(key);
    await mkdir(path.dirname(key), { recursive: true });
    await copyFile(a.storage_key, key);
    await trx.updateTable('voucher_attachment').set({ storage_key: key }).where('id', '=', row.id).execute();
  }
  if (atts.length) await trx.updateTable('voucher').set({ attachments_count: atts.length }).where('id', '=', voucherId).execute();
}

export async function approveRequest(trx: Trx, auth: Auth, id: string, note: string | null, attachmentDir: string, written: string[]) {
  const r = await getRequestRow(trx, id, true);
  const step = await canAct(trx, auth, r);
  await log(trx, auth.tenantId!, id, step.stepNo, 'approve', auth.userId, note);
  if (r.current_step < r.steps.length) {
    await trx.updateTable('approval_request').set({ current_step: r.current_step + 1 }).where('id', '=', id).execute();
    return { state: 'submitted', currentStep: r.current_step + 1, voucherId: null };
  }
  const v = await createPaymentVoucher(trx, auth, r);
  await copyAttachments(trx, auth, id, v.id, attachmentDir, written);
  await trx.updateTable('approval_request').set({ state: 'approved', voucher_id: v.id, decided_at: new Date().toISOString() }).where('id', '=', id).execute();
  return { state: 'approved', currentStep: r.current_step, voucherId: v.id };
}

export async function rejectRequest(trx: Trx, auth: Auth, id: string, reason: string) {
  const r = await getRequestRow(trx, id, true);
  const step = await canAct(trx, auth, r);
  await log(trx, auth.tenantId!, id, step.stepNo, 'reject', auth.userId, reason);
  await trx.updateTable('approval_request').set({ state: 'rejected', reject_reason: reason, decided_at: new Date().toISOString() }).where('id', '=', id).execute();
}

// ---- Danh sách ----
export const BOXES = ['mine', 'inbox', 'all'] as const;
export type Box = (typeof BOXES)[number];
const LIST_LIMIT = 500;

async function inboxRows(trx: Trx, auth: Auth) {
  const me = await trx.selectFrom('tenant_user').select('role_id').where('user_id', '=', auth.userId).executeTakeFirstOrThrow();
  return baseQuery(trx).where('r.state', '=', 'submitted').where('r.requester_id', '<>', auth.userId)
    .where(sql<boolean>`coalesce((r.steps -> (r.current_step - 1) ->> 'userId')::uuid = ${auth.userId}::uuid, (r.steps -> (r.current_step - 1) ->> 'roleId')::uuid = ${me.role_id}::uuid)`)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('approval_step_log as l').select('l.id').whereRef('l.request_id', '=', 'r.id').where('l.actor_id', '=', auth.userId).where('l.action', '=', 'approve'))))
    .orderBy('r.submitted_at').limit(LIST_LIMIT).execute();
}

export async function listRequests(trx: Trx, auth: Auth, box: Box, f: { state?: string | undefined; from?: string | undefined; to?: string | undefined } = {}): Promise<RequestDto[]> {
  let rows: Row[];
  if (box === 'inbox') {
    if (!auth.permissions.has('approval_request.approve')) throw new AppError('FORBIDDEN', 'Thiếu quyền approval_request.approve', 403);
    rows = await inboxRows(trx, auth);
  } else {
    if (box === 'all' && !auth.permissions.has('approval_request.view')) throw new AppError('FORBIDDEN', 'Thiếu quyền approval_request.view', 403);
    let q = baseQuery(trx);
    if (box === 'mine') q = q.where('r.requester_id', '=', auth.userId);
    if (f.state) q = q.where('r.state', '=', f.state);
    if (f.from) q = q.where('r.request_date', '>=', f.from);
    if (f.to) q = q.where('r.request_date', '<=', f.to);
    rows = await q.orderBy('r.created_at', 'desc').limit(LIST_LIMIT).execute();
  }
  const accs = await accountsOf(trx, rows.map((r) => r.account_code));
  return rows.filter((r) => visible(auth, r, accs)).map(toDto);
}

export async function inboxCount(trx: Trx, auth: Auth): Promise<number> {
  return auth.permissions.has('approval_request.approve') ? (await listRequests(trx, auth, 'inbox')).length : 0;
}
