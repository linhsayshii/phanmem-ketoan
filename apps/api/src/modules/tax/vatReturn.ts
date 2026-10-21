import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { isVatRate8Verified, isVatTemplateComplete, loadVatTemplate, type VatTemplate } from '@kt/coa-data';
import { D, evalVatReturn, VAT_SHARED_GROUP, vatInvoiceKey, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { getSettings } from '../core/settings.js';
import { legalParam } from '../core/legal.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import type { ReportDoc } from '../reporting/print/html.js';
import { invoiceRegister, specOf, type PeriodKind, type PeriodQ } from './register.js';

// Tờ khai thuế GTGT 01/GTGT: số liệu hóa đơn lấy từ bảng kê (invoiceRegister, cùng truy vấn với màn hình bảng kê), chỉ tiêu tính theo mẫu dữ liệu của @kt/coa-data
// (evalVatReturn). Lần đầu revision 0; đã chốt thì lập bổ sung revision n + 1. [22] = [43] của tờ khai lần đầu đã chốt của kỳ liền trước; chênh lệch số còn được khấu trừ
// chuyển kỳ sau của tờ khai bổ sung khai vào [38] (tăng) hoặc [37] (giảm) của kỳ phát hiện sai sót, không qua [22] (TT 89/2026 Phụ lục II điểm 3 a, b, c, d, trang 517-518).
type Trx = Transaction<Database>;
const FORM = '01/GTGT';
const amounts = z.record(z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG));
// Ghi đè được âm: vd. [25] khi trả lại hàng mua (GGM) lớn hơn mua vào trong kỳ.
const overridesIn = z.record(z.string().regex(/^-?\d{1,16}$/, 'Số ghi đè phải là số nguyên VND tối đa 16 chữ số, có thể âm'));
export const returnInput = z.object({
  year: z.number().int().min(2000).max(2100), periodKind: z.enum(['month', 'quarter']), period: z.number().int().min(1).max(12), revision: z.number().int().min(0).optional(),
  manual: amounts.optional(), overrides: overridesIn.optional(),
});
export const returnUpdate = z.object({ manual: amounts.optional(), overrides: overridesIn.optional() });

const lock = (trx: Trx, tenantId: string) => sql`SELECT pg_advisory_xact_lock(hashtext('tax_return'), hashtext(${tenantId}::text))`.execute(trx);

export async function templateFor(trx: Trx, from: string, label: string): Promise<VatTemplate> {
  const version = await legalParam<string>(trx, 'vat_return_template', from);
  if (version !== 'TT89' && version !== 'TT80') throw new AppError('VAT_TEMPLATE_UNAVAILABLE', `Không có mẫu tờ khai 01/GTGT áp dụng cho ${label}`, 409);
  if (!isVatTemplateComplete(version)) {
    const msg = (() => { try { loadVatTemplate(version); return ''; } catch (e) { return (e as Error).message; } })();
    throw new AppError('VAT_TEMPLATE_UNAVAILABLE', `${label}: ${msg}`, 409);
  }
  return loadVatTemplate(version);
}

// Chỉ tiêu nhập tay đã lưu: dòng 'manual' của mẫu và [22] (chỉ dùng khi kỳ trước chưa có tờ khai lần đầu đã chốt; có thì compute bỏ qua, không cảnh báo).
const manualOf = (t: VatTemplate, values: Record<string, string>) =>
  Object.fromEntries(t.lines.filter((l) => l.kind === 'manual' || l.kind === 'carry').flatMap((l) => (values[l.code] !== undefined ? [[l.code, values[l.code]!]] : [])));

// Chỉ tiêu lệch giữa số đã lưu và số tính lại theo sổ hiện tại (chốt dùng để chặn, xem trước dùng để báo).
export const diffValues = (stored: Record<string, string>, fresh: Record<string, string>) =>
  [...new Set([...Object.keys(stored), ...Object.keys(fresh)])].filter((k) => stored[k] !== fresh[k]).map((code) => ({ code, stored: stored[code] ?? null, fresh: fresh[code] ?? null }));

interface Computed { version: string; values: Record<string, string>; hints: Record<string, string>; warnings: string[]; carryLocked: boolean }
// explicitManual: manual do người dùng gửi trong yêu cầu này (không phải đọc lại từ values đã lưu); chỉ khi đó mới cảnh báo [22] nhập tay không dùng.
async function compute(trx: Trx, q: PeriodQ, manual: Record<string, string>, overrides: Record<string, string>, explicitManual: boolean): Promise<Computed> {
  const s = specOf(q); const t = await templateFor(trx, s.from, s.label);
  const allowManual = new Set(t.lines.filter((l) => l.kind === 'manual' || l.kind === 'carry').map((l) => l.code));
  for (const c of Object.keys(manual)) if (!allowManual.has(c)) throw new AppError('VALIDATION', `Chỉ tiêu [${c}] không nhập tay được`, 400);
  for (const c of Object.keys(overrides)) if (!t.lines.find((l) => l.code === c)?.overridable) throw new AppError('VALIDATION', `Chỉ tiêu [${c}] không ghi đè được`, 400);
  const carryLine = t.lines.find((l) => l.kind === 'carry')!.code;
  const hints: Record<string, string> = {}; const warnings: string[] = [];

  const invoice: Record<string, string> = {};
  const add = (key: string, v: string) => { invoice[key] = D(invoice[key] ?? 0).plus(v).toFixed(0); };
  const rate8: { no: string; date: string }[] = []; let group08 = false;
  for (const direction of ['purchase', 'sale'] as const) {
    const r = await invoiceRegister(trx, direction, q);
    if (r.note) warnings.push(r.note);
    for (const g of r.groups) {
      add(vatInvoiceKey(direction, g.code, 'base'), g.baseTotal); add(vatInvoiceKey(direction, g.code, 'tax'), g.taxTotal);
      for (const x of g.rows) {
        if (x.isImport) { add(vatInvoiceKey(direction, g.code, 'base', true), x.baseAmount); add(vatInvoiceKey(direction, g.code, 'tax', true), x.taxAmount); }
        if (x.taxRate !== null && D(x.taxRate).eq(8)) rate8.push({ no: x.invoiceNo, date: x.invoiceDate });
      }
      if (direction === 'sale' && g.code === '08' && g.rows.length) group08 = true;
    }
  }
  if (group08 && !isVatRate8Verified()) warnings.push('Hóa đơn bán ra thuế suất 8% đang cộng vào chỉ tiêu [32]/[33] (thuế suất 10%): mẫu 01/GTGT TT 89/2026 không có dòng 8% và văn bản chưa nói khai ở chỉ tiêu nào, đây là giả định tạm của phần mềm; lập kèm Mẫu số 01 Phụ lục II NĐ 174/2025/NĐ-CP');
  const outside: string[] = [];
  for (const date of [...new Set(rate8.map((x) => x.date))]) if (!(await legalParam(trx, 'vat_reduced_rate', date))) outside.push(...rate8.filter((x) => x.date === date).map((x) => `${x.no} (${x.date})`));
  if (outside.length) warnings.push(`Hóa đơn dùng thuế suất 8% ngoài thời gian giảm thuế GTGT (tham số vat_reduced_rate): ${[...new Set(outside)].join(', ')}`);

  // [22]: [43] của tờ khai lần đầu đã chốt có kỳ kết thúc ở tháng liền trước kỳ này (kỳ trước có thể là tháng hoặc quý khi công ty đổi kỳ khai giữa các năm).
  // Tờ khai bổ sung của kỳ trước không đổi [22]: chênh lệch của nó vào [37]/[38] của kỳ phát hiện (gợi ý ở dưới).
  const kindName = (k: string) => (k === 'month' ? 'tháng' : 'quý');
  const cands = await trx.selectFrom('tax_return').select(['year', 'period', 'period_kind', sql<string>`values->>'43'`.as('carry')]).where('form_code', '=', FORM).where('status', '=', 'final')
    .where('revision', '=', 0).where(sql<boolean>`year * 12 + CASE period_kind WHEN 'month' THEN period ELSE period * 3 END = ${s.lo - 1}`).execute();
  // Cả tờ khai tháng 12 lẫn quý 4 cùng chốt (không hợp lệ): lấy tờ khai cùng loại kỳ với kỳ này (không lưu cài đặt kỳ khai theo năm), cảnh báo.
  const prev = cands.find((c) => c.period_kind === q.periodKind) ?? cands[0];
  if (cands.length > 1) warnings.push(`Kỳ trước có cả tờ khai tháng và tờ khai quý đã chốt: [${carryLine}] lấy từ tờ khai ${kindName(prev!.period_kind)} ${prev!.period}/${prev!.year}; kiểm tra lại kỳ khai`);
  let carry: string;
  if (prev) {
    carry = prev.carry ?? '0';
    hints[carryLine] = `Lấy chỉ tiêu [43] của tờ khai lần đầu ${kindName(prev.period_kind)} ${prev.period}/${prev.year} đã chốt`;
    if (explicitManual && manual[carryLine] !== undefined && manual[carryLine] !== carry) warnings.push(`Chỉ tiêu [${carryLine}] nhập tay không dùng: đã có tờ khai kỳ trước đã chốt`);
  } else {
    carry = manual[carryLine] ?? '0';
    const p = await trx.selectFrom('fiscal_period').select('regime').where('date_from', '<=', s.from).where('date_to', '>=', s.from).where('period_no', '>', 0).executeTakeFirst();
    const bal = p ? (await sql<{ v: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS v FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
      WHERE v.state IN ('posted', 'reversed') AND l.posting_date < ${s.from}::date AND a.regime = ${p.regime} AND a.code LIKE '133%'`.execute(trx)).rows[0]!.v : '0';
    hints[carryLine] = `Kỳ trước chưa có tờ khai đã chốt: nhập tay; gợi ý số dư Nợ TK 133 đầu kỳ ${D(bal).toFixed(0)}`;
  }

  // Tờ khai bổ sung đã chốt của các kỳ trước, chốt trong kỳ này (coi là kỳ phát hiện sai sót): chênh lệch [43] so với lần khai liền trước của cùng kỳ là số gợi ý cho
  // [38] (tăng) hoặc [37] (giảm). Chỉ gợi ý: người dùng nhập [37]/[38] (còn gồm các điều chỉnh khác theo ghi chú 5 của mẫu).
  const supp = (await sql<{ year: number; period: number; period_kind: string; revision: number; delta: string }>`
    SELECT b.year, b.period, b.period_kind, b.revision, (coalesce(b.values->>'43', '0')::numeric - coalesce(a.values->>'43', '0')::numeric)::text AS delta
    FROM tax_return b JOIN tax_return a ON a.form_code = b.form_code AND a.year = b.year AND a.period_kind = b.period_kind AND a.period = b.period AND a.revision = b.revision - 1
    WHERE b.form_code = ${FORM} AND b.status = 'final' AND b.revision > 0
      AND b.year * 12 + CASE b.period_kind WHEN 'month' THEN b.period ELSE b.period * 3 END < ${s.lo}
      AND (b.finalized_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN ${s.from}::date AND ${s.to}::date
    ORDER BY b.year, b.period, b.revision`.execute(trx)).rows.filter((x) => !D(x.delta).isZero());
  for (const [code, sign, word] of [['38', 1, 'tăng'], ['37', -1, 'giảm']] as const) {
    const list = supp.filter((x) => D(x.delta).times(sign).gt(0));
    if (!list.length || !t.lines.some((l) => l.code === code)) continue;
    const total = list.reduce((a, x) => a.plus(D(x.delta).abs()), D(0)).toFixed(0);
    hints[code] = `Gợi ý ${total}: tờ khai bổ sung ${list.map((x) => `${kindName(x.period_kind)} ${x.period}/${x.year} lần ${x.revision} (${D(x.delta).abs().toFixed(0)})`).join(', ')} làm ${word} số thuế còn được khấu trừ chuyển kỳ sau; khai vào [${code}] kỳ phát hiện (TT 89/2026 Phụ lục II điểm 3)`;
    warnings.push(`Có tờ khai bổ sung kỳ trước làm ${word} số thuế còn được khấu trừ: khai ${total} vào chỉ tiêu [${code}] (xem gợi ý). Phần mềm coi kỳ phát hiện sai sót là kỳ chứa ngày chốt tờ khai bổ sung; nếu đã khai ở kỳ khác thì không khai lại; nếu đã đề nghị hoàn ([42]) xem TT 89/2026 Phụ lục II điểm 3 b.2`);
  }

  const values = evalVatReturn(t, { invoice, carry, manual, overrides });
  // Ràng buộc in trên mẫu (ghi chú của [40b], [42]): số nhập tay không vượt số tính, nếu không [40]/[43] âm và chuyển sang kỳ sau sai.
  for (const [a, b] of [['40b', '40a'], ['42', '41']] as const)
    if (values[a] !== undefined && values[b] !== undefined && D(values[a]).gt(values[b])) throw new AppError('VALIDATION', `Chỉ tiêu [${a}] không được lớn hơn [${b}] (${values[b]})`, 400);

  const sharedTax = invoice[vatInvoiceKey('purchase', VAT_SHARED_GROUP, 'tax')];
  for (const l of t.lines.filter((x) => x.overridable && x.invoice)) {
    hints[l.code] = sharedTax && !D(sharedTax).isZero()
      ? `Gợi ý của phần mềm: thuế nhóm 01 cộng thuế nhóm 03 (${sharedTax}) nhân tỷ lệ doanh thu chịu thuế [27]/[34] = ${values['27']}/${values['34']}; sửa khi phân bổ thuế đầu vào dùng chung khác`
      : 'Gợi ý của phần mềm: thuế nhóm 01 cộng thuế nhóm 03 phân bổ theo tỷ lệ doanh thu chịu thuế; sửa khi cần';
    if (sharedTax && !D(sharedTax).isZero()) warnings.push(`Chỉ tiêu [${l.code}] phân bổ thuế đầu vào dùng chung theo tỷ lệ doanh thu là gợi ý của phần mềm, không phải số của văn bản; kiểm tra trước khi chốt`);
  }
  return { version: t.version, values, hints, warnings, carryLocked: !!prev };
}

const COLS = ['id', 'form_code', 'template_version', 'period_kind', 'year', 'period', 'revision', 'status', 'values', 'overrides', 'created_at', 'finalized_at'] as const;
interface Row { id: number; form_code: string; template_version: string; period_kind: string; year: number; period: number; revision: number; status: string; values: Record<string, string>; overrides: Record<string, string>; created_at: string; finalized_at: string | null }
const dto = (r: Row) => ({ id: r.id, formCode: r.form_code, templateVersion: r.template_version, periodKind: r.period_kind as PeriodKind, year: r.year, period: r.period, revision: r.revision, status: r.status,
  values: r.values, overrides: r.overrides, createdAt: r.created_at, finalizedAt: r.finalized_at });
export type TaxReturnDto = ReturnType<typeof dto>;

async function rowOf(trx: Trx, id: number, forUpdate = false): Promise<Row> {
  let q = trx.selectFrom('tax_return').select(COLS).where('id', '=', id);
  if (forUpdate) q = q.forUpdate();
  const r = await q.executeTakeFirst();
  if (!r) throw new AppError('TAX_RETURN_NOT_FOUND', 'Không tìm thấy tờ khai', 404);
  return r as Row;
}
const qOf = (r: Row): PeriodQ => ({ year: r.year, period: r.period, periodKind: r.period_kind as PeriodKind });

// Danh sách kèm kỳ phát hiện sai sót của tờ khai bổ sung đã chốt: kỳ (theo kỳ khai của công ty) chứa ngày chốt theo giờ Việt Nam. Màn hình dùng số này, không tự tính lại.
export interface Discovery { year: number; periodKind: PeriodKind; period: number }
export type TaxReturnListItem = TaxReturnDto & { discovery: Discovery | null };
export async function listReturns(trx: Trx, tenantId: string, year?: number): Promise<TaxReturnListItem[]> {
  const kind = (await getSettings(trx, tenantId)).vat_period;
  const local = sql<string>`(finalized_at AT TIME ZONE 'Asia/Ho_Chi_Minh')`;
  let q = trx.selectFrom('tax_return').select([...COLS, sql<number>`extract(year from ${local})::int`.as('fy'), sql<number>`extract(month from ${local})::int`.as('fm')]).where('form_code', '=', FORM);
  if (year !== undefined) q = q.where('year', '=', year);
  return (await q.orderBy('year', 'desc').orderBy('period_kind').orderBy('period', 'desc').orderBy('revision', 'desc').execute()).map((r) => ({ ...dto(r as unknown as Row),
    discovery: r.revision > 0 && r.status === 'final' && r.fy !== null ? { year: r.fy, periodKind: kind, period: kind === 'month' ? r.fm : Math.ceil(r.fm / 3) } : null }));
}
export const getReturn = async (trx: Trx, id: number): Promise<TaxReturnDto> => dto(await rowOf(trx, id));

export async function createReturn(trx: Trx, ctx: { tenantId: string; userId: string }, input: z.infer<typeof returnInput>) {
  await lock(trx, ctx.tenantId);
  const q: PeriodQ = { year: input.year, period: input.period, periodKind: input.periodKind };
  specOf(q); // kiểm tháng 1-12 / quý 1-4
  const latest = await trx.selectFrom('tax_return').select(['id', 'revision', 'status']).where('form_code', '=', FORM).where('year', '=', q.year).where('period_kind', '=', q.periodKind).where('period', '=', q.period)
    .orderBy('revision', 'desc').executeTakeFirst();
  // Kỳ khai theo cài đặt vat_period; tờ khai bổ sung của kỳ đã khai theo kiểu cũ (trước khi đổi tháng/quý) vẫn lập được.
  const vatPeriod = (await getSettings(trx, ctx.tenantId)).vat_period;
  if (!latest && q.periodKind !== vatPeriod) throw new AppError('VALIDATION', `Công ty khai thuế GTGT theo ${vatPeriod === 'month' ? 'tháng' : 'quý'} (cài đặt kỳ khai thuế GTGT): không lập tờ khai ${q.periodKind === 'month' ? 'tháng' : 'quý'}`, 400);
  if (latest?.status === 'draft') throw new AppError('TAX_RETURN_DRAFT_EXISTS', `Kỳ này đã có tờ khai nháp${latest.revision ? ` bổ sung lần ${latest.revision}` : ''}: sửa hoặc chốt tờ khai đó`, 409, { id: latest.id });
  const revision = latest ? latest.revision + 1 : 0;
  if (input.revision !== undefined && input.revision !== revision) throw new AppError('TAX_RETURN_REVISION', revision === 0 ? 'Kỳ này chưa có tờ khai: lập lần đầu (revision 0)' : `Lần bổ sung tiếp theo của kỳ này là lần ${revision}`, 409);
  const overrides = input.overrides ?? {};
  const c = await compute(trx, q, input.manual ?? {}, overrides, true);
  const r = await trx.insertInto('tax_return').values({ tenant_id: ctx.tenantId, form_code: FORM, template_version: c.version, period_kind: q.periodKind, year: q.year, period: q.period, revision,
    values: JSON.stringify(c.values), overrides: JSON.stringify(overrides), created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow();
  return { ...(await getReturn(trx, r.id)), hints: c.hints, warnings: c.warnings, carryLocked: c.carryLocked };
}

async function draftOf(trx: Trx, tenantId: string, id: number): Promise<Row> {
  await lock(trx, tenantId);
  const r = await rowOf(trx, id, true);
  if (r.status === 'final') throw new AppError('TAX_RETURN_FINAL', 'Tờ khai đã chốt, không sửa được; lập tờ khai bổ sung', 409);
  return r;
}

// Sửa nháp: manual/overrides gửi lên thay toàn bộ phần tương ứng (bỏ trống thì giữ phần đã lưu), tính lại theo sổ hiện tại.
export async function updateReturn(trx: Trx, tenantId: string, id: number, input: z.infer<typeof returnUpdate>) {
  const r = await draftOf(trx, tenantId, id);
  const overrides = input.overrides ?? r.overrides;
  const c = await compute(trx, qOf(r), input.manual ?? manualOf(loadVatTemplate(r.template_version as VatTemplate['version']), r.values), overrides, input.manual !== undefined);
  await trx.updateTable('tax_return').set({ template_version: c.version, values: JSON.stringify(c.values), overrides: JSON.stringify(overrides) }).where('id', '=', id).execute();
  return { ...(await getReturn(trx, id)), hints: c.hints, warnings: c.warnings, carryLocked: c.carryLocked };
}

// Chốt khóa đúng số người dùng đã thấy: tính lại theo sổ hiện tại để kiểm; lệch số đã lưu thì 409 TAX_RETURN_STALE (không ghi gì), người dùng lưu lại nháp để tính lại
// và kiểm tra rồi mới chốt. Khớp thì chỉ đổi trạng thái (trigger chặn sửa, xóa từ đó).
export async function finalizeReturn(trx: Trx, ctx: { tenantId: string; userId: string }, id: number) {
  const r = await draftOf(trx, ctx.tenantId, id);
  const c = await compute(trx, qOf(r), manualOf(loadVatTemplate(r.template_version as VatTemplate['version']), r.values), r.overrides, false);
  const changed = diffValues(r.values, c.values);
  if (changed.length || c.version !== r.template_version)
    throw new AppError('TAX_RETURN_STALE', `Số liệu sổ đã thay đổi kể từ lần tính trước (${changed.map((x) => `[${x.code}]`).join(', ') || 'mẫu tờ khai'}): lưu lại nháp để tính lại và kiểm tra trước khi chốt`, 409, { changed });
  await trx.updateTable('tax_return').set({ status: 'final', finalized_by: ctx.userId, finalized_at: sql<string>`now()` }).where('id', '=', id).execute();
  return { ...(await getReturn(trx, id)), hints: c.hints, warnings: c.warnings, carryLocked: c.carryLocked };
}

// Mẫu chỉ tiêu áp dụng cho kỳ (màn hình dựng bảng từ đây, không viết cứng danh sách chỉ tiêu). Kỳ trước 01/7/2026 chưa có mẫu: 409 VAT_TEMPLATE_UNAVAILABLE.
export async function templateOfPeriod(trx: Trx, q: PeriodQ): Promise<VatTemplate> { const s = specOf(q); return templateFor(trx, s.from, s.label); }

// Gợi ý, cảnh báo và số lệch so với sổ hiện tại của tờ khai nháp (chỉ đọc, không ghi): màn hình mở lại nháp vẫn thấy gợi ý [37]/[38], [25]; tờ khai đã chốt không có (số đã khóa).
export async function previewReturn(trx: Trx, id: number) {
  const r = await rowOf(trx, id);
  if (r.status === 'final') return { hints: {} as Record<string, string>, warnings: [] as string[], carryLocked: false, changed: [] as { code: string; stored: string | null; fresh: string | null }[] };
  const c = await compute(trx, qOf(r), manualOf(loadVatTemplate(r.template_version as VatTemplate['version']), r.values), r.overrides, false);
  const changed = diffValues(r.values, c.values);
  return { hints: c.hints, warnings: c.warnings, carryLocked: c.carryLocked, changed };
}

// Chú thích dấu in dưới tờ khai, dựng từ mẫu dữ liệu (clamp/formula): chỉ tiêu clamp negativePart lưu số dương là phần âm của biểu thức đổi dấu; chỉ tiêu tính từ nó cùng dấu dương.
function signNotes(t: VatTemplate): string[] {
  const clamped = t.lines.filter((l) => l.clamp === 'negativePart' && l.formula);
  return [...clamped.map((l) => `Chỉ tiêu [${l.code}] hiện số dương: là phần âm của biểu thức ${l.formula} đổi dấu (mẫu ghi điều kiện ≤ 0).`),
    ...t.lines.filter((l) => l.formula && !l.clamp && clamped.some((c) => l.formula!.includes(`[${c.code}]`))).map((l) => `Chỉ tiêu [${l.code}] = ${l.formula}, tính từ số dương nói trên.`)];
}

// Tài liệu in theo bố cục mẫu: chỉ tiêu theo thứ tự và mục của mẫu dữ liệu; không thêm chữ ban hành ngoài mẫu. Chỉ tiêu cờ [21] in dạng ô đánh dấu.
export async function returnDoc(trx: Trx, tenantId: string, r: TaxReturnDto): Promise<{ doc: ReportDoc; name: string }> {
  const t = loadVatTemplate(r.templateVersion as VatTemplate['version']); const s = specOf({ year: r.year, period: r.period, periodKind: r.periodKind });
  const rows = t.lines.map((l) => ({ section: l.section, code: `[${l.code}]`, label: l.kind === 'flag' ? `${l.label}: ${r.values[l.code] === 'X' ? '[X]' : '[ ]'}` : l.label, value: l.kind === 'flag' ? '' : r.values[l.code] ?? '' }));
  const doc: ReportDoc = { title: 'Tờ khai thuế giá trị gia tăng', formNo: FORM, issuedBy: '', company: await companyInfo(trx, tenantId, '', null), landscape: false, sheetName: 'Tờ khai 01-GTGT',
    subtitle: `Kỳ tính thuế: ${s.label}. ${r.revision ? `Khai bổ sung lần ${r.revision}` : 'Khai lần đầu'}${r.status === 'final' ? '' : ' (bản nháp, chưa chốt)'}`,
    columns: [{ key: 'section', label: 'Mục', width: '10%' }, { key: 'code', label: 'Mã', width: '8%' }, { key: 'label', label: 'Chỉ tiêu' }, { key: 'value', label: 'Giá trị (VND)', type: 'number', width: '18%' }],
    rows, outro: signNotes(t) };
  return { doc, name: `to-khai-01-gtgt-${r.year}-${r.periodKind === 'month' ? 'T' : 'Q'}${r.period}${r.revision ? `-bo-sung-${r.revision}` : ''}` };
}
