import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { isCitTemplateComplete, loadCitTemplate, type CitTemplate } from '@kt/coa-data';
import { CitError, D, Decimal, evalCitReturn } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { legalParam } from '../core/legal.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import { b02Figures, citLedger, fiscalYearInfo, monthEndAfter, paidBetween, prevYearRevenue, RATE_CONDITIONS, rateOfYear, requireFiscalYear } from './citEstimate.js';
import { diffValues } from './vatReturn.js';
import { XML_FORMATS } from './xml/index.js';

// Tờ khai quyết toán thuế TNDN 03/TNDN (TT 89/2026): lưu trong tax_return (form_code '03/TNDN', kỳ năm: period_kind 'year', period 1). values tính từ sổ cái
// (A1 = lợi nhuận trước thuế B02 cả năm, G2 = số đã tạm nộp) và mặc định của phần mềm (C7a thuế suất, C2 miễn thuế, C15 giảm thuế NQ 43/2026) cộng overrides là
// số người dùng nhập (chỉ tiêu overridable của mẫu). Lần đầu revision 0; đã chốt thì lập bổ sung revision n + 1 (như 01/GTGT, cùng trigger chặn sửa tờ khai đã chốt).
type Trx = Transaction<Database>;
const FORM = '03/TNDN';
export const citReturnInput = z.object({ year: z.number().int().min(2000).max(2100), revision: z.number().int().min(0).optional(), overrides: z.record(z.string().max(500)).optional() });
export const citReturnUpdate = z.object({ overrides: z.record(z.string().max(500)) });
const lock = (trx: Trx, tenantId: string) => sql`SELECT pg_advisory_xact_lock(hashtext('tax_return'), hashtext(${tenantId}::text))`.execute(trx);

// Mẫu áp dụng: tham số cit_return_template tra theo ngày cuối năm tài chính (kỳ kết thúc từ 01/7/2026 dùng TT89, từ 31/12/2021 đến 30/6/2026 dùng TT80); cổng 03TNDN_<mẫu> tắt thì 409.
export async function citTemplateFor(trx: Trx, year: number): Promise<CitTemplate> {
  const end = (await fiscalYearInfo(trx, year))?.to ?? `${year}-12-31`;
  const version = await legalParam<string>(trx, 'cit_return_template', end);
  if (version !== 'TT89' && version !== 'TT80') throw new AppError('CIT_TEMPLATE_UNAVAILABLE', `Không có mẫu tờ khai 03/TNDN áp dụng cho kỳ tính thuế năm ${year} (kỳ kết thúc trước 31/12/2021 dùng mẫu trước TT 80/2021, chưa nhập)`, 409);
  if (!isCitTemplateComplete(version)) throw new AppError('CIT_TEMPLATE_UNAVAILABLE', `Mẫu tờ khai 03/TNDN theo ${version === 'TT80' ? 'TT 80/2021' : 'TT 89/2026'} chưa đối chiếu đủ văn bản gốc (status.json 03TNDN_${version})`, 409);
  return loadCitTemplate(version);
}

interface Computed { version: string; values: Record<string, string>; hints: Record<string, string>; warnings: string[] }
async function compute(trx: Trx, tenantId: string, year: number, overrides: Record<string, string>): Promise<Computed> {
  const t = await citTemplateFor(trx, year);
  const fy = await requireFiscalYear(trx, year);
  const hints: Record<string, string> = {}; const warnings: string[] = []; const defaults: Record<string, string> = {};
  const m = citLedger(fy.regime);
  const hasC7a = t.lines.some((l) => l.code === 'C7a');
  const cur = await b02Figures(trx, tenantId, fy.regime, fy.from, fy.to);
  hints.A1 = `Chỉ tiêu ${m.profitLine} "Tổng lợi nhuận kế toán trước thuế" của B02 từ ${fy.from} đến ${fy.to}`;
  // Số đã tạm nộp cho năm: từ đầu quý 2 (khoản nộp tháng 1-3 thường thuộc năm trước) đến hết tháng thứ 3 sau năm (hạn nộp quyết toán, ghi chú 3 của mẫu).
  const paidFrom = (fy.months[3] ?? fy.months[0]!).from; const paidTo = monthEndAfter(fy.to, 3);
  const ledger = { A1: cur.profit, G2: await paidBetween(trx, fy.regime, paidFrom, paidTo) };
  hints.G2 = `Phát sinh Nợ TK ${m.payableAccount} đối ứng tiền từ ${paidFrom} đến ${paidTo}; khoản nộp trong khoảng này cho năm khác (hoặc khoản nộp đầu năm cho năm này) thì sửa tay`;

  const run = () => evalCitReturn(t, { ledger, defaults, overrides });
  let splitRate = false;
  const prev = await prevYearRevenue(trx, tenantId, year);
  try {
    const r = await rateOfYear(trx, fy, prev?.revenue ?? null, undefined, false);
    const why = `${r.basis}${prev ? `; ${prev.note}` : ''}`;
    if (hasC7a) { defaults.C7a = r.rate; hints.C7a = why; }
    else if (r.rate !== '20') {
      // Mẫu TT 80/2021 không có ô thuế suất phổ thông: C7 nhân cố định 20%; thu nhập tính thuế theo thuế suất khác (15%, 17%) khai ở C8 (số) và C8a (thuế suất).
      defaults.C8a = r.rate; splitRate = true;
      hints.C8a = `${why}; mẫu TT 80/2021 không có ô thuế suất phổ thông nên khai ở C8/C8a, C7 = phần còn lại theo thuế suất 20%`; hints.C8 = hints.C8a;
    } else hints.C8a = `${why}; thuế suất 20% khai ở C7 (in cố định trong C9 của mẫu TT 80/2021)`;
    warnings.push(RATE_CONDITIONS);
  } catch (e) {
    if (!(e instanceof CitError) || e.code !== 'CIT_RATE_REQUIRED') throw e;
    const rateLine = hasC7a ? 'C7a' : 'C8a'; hints[rateLine] = e.message;
    if (overrides[rateLine] === undefined) warnings.push(hasC7a ? `Chưa xác định được thuế suất phổ thông: nhập chỉ tiêu C7a (${e.message})` : `Chưa xác định được thuế suất: mẫu TT 80/2021 tính thu nhập tính thuế ở C7 theo thuế suất 20%, nếu thuế suất khác 20% nhập C8 và C8a (${e.message})`);
  }
  for (const l of t.lines) if (l.printed === false && l.note) hints[l.code] = l.note;

  // Miễn thuế doanh thu năm trước từ 01 tỷ trở xuống (NĐ 141/2026 Điều 2 bổ sung khoản 15 Điều 4 "Thu nhập được miễn thuế" NĐ 320/2025): gợi ý C2 = C1.
  const exemptMax = await legalParam<string>(trx, 'cit_exempt_revenue', fy.from);
  if (exemptMax && prev && D(prev.revenue).lte(exemptMax)) {
    defaults.C2 = Decimal.max(0, D(run().C1!)).toFixed(0);
    hints.C2 = `Gợi ý: miễn thuế cả thu nhập SXKD vì doanh thu năm trước ${prev.revenue} từ ${exemptMax} trở xuống (NĐ 141/2026/NĐ-CP Điều 2; NĐ 320/2025 Điều 4 khoản 15)`;
    warnings.push('Áp dụng miễn thuế TNDN doanh thu thấp: không áp dụng cho công ty con, công ty có quan hệ liên kết với doanh nghiệp không đáp ứng điều kiện (NĐ 141/2026 Điều 2 điểm d); kiểm tra trước khi chốt.');
  }
  // Mẫu TT 80/2021, thuế suất khác 20%: C8 = toàn bộ TNTT sau trích quỹ (C6, tính sau khi đã gợi ý C2); C7 còn lại 0.
  if (splitRate) defaults.C8 = Decimal.max(0, D(run().C6!)).toFixed(0);
  // Giảm thuế NQ 43/2026: doanh thu của chính năm không quá mức trần; số giảm tính trên thuế phải nộp sau ưu đãi (C9 - C10 - C14), gợi ý ở C15.
  const red = await legalParam<{ rate: number; maxRevenue: string }>(trx, 'cit_reduction', fy.from);
  if (red && D(cur.revenue).lte(red.maxRevenue)) {
    const v = run(); const base = Decimal.max(0, D(v.C9!).minus(v.C10!).minus(v.C14!));
    defaults.C15 = base.times(red.rate).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
    hints.C15 = `Gợi ý: giảm ${red.rate}% số thuế phải nộp sau ưu đãi (C9 - C10 - C14 = ${base.toFixed(0)}) vì doanh thu năm ${year} (${cur.revenue}) không quá ${red.maxRevenue} (NQ 43/2026/QH16 Điều 1 khoản 2)`;
    warnings.push(`Giảm ${red.rate}% thuế TNDN theo NQ 43/2026/QH16 gợi ý ở chỉ tiêu C15: mẫu 03/TNDN không chỉ rõ chỉ tiêu khai số giảm này; số gợi ý chỉ tính trên thuế TNDN của hoạt động sản xuất kinh doanh (C9 - C10 - C14), chưa gồm thuế của thu nhập từ chuyển nhượng bất động sản (mục D), chờ hướng dẫn; không áp dụng cho doanh nghiệp hình thành từ chia, tách sau 24/8/2026 có tổng doanh thu sau chia, tách trên 10 tỷ đồng; Chính phủ chưa có văn bản hướng dẫn chi tiết.`);
  }
  return { version: t.version, values: run(), hints, warnings };
}

const COLS = ['id', 'form_code', 'template_version', 'period_kind', 'year', 'period', 'revision', 'status', 'values', 'overrides', 'created_at', 'finalized_at'] as const;
interface Row { id: number; form_code: string; template_version: string; period_kind: string; year: number; period: number; revision: number; status: string; values: Record<string, string>; overrides: Record<string, string>; created_at: string; finalized_at: string | null }
const dto = (r: Row) => ({ id: r.id, formCode: r.form_code, templateVersion: r.template_version, periodKind: 'year' as const, year: r.year, period: r.period, revision: r.revision, status: r.status,
  values: r.values, overrides: r.overrides, createdAt: r.created_at, finalizedAt: r.finalized_at });
export type CitReturnDto = ReturnType<typeof dto>;
async function rowOf(trx: Trx, id: number, forUpdate = false): Promise<Row> {
  let q = trx.selectFrom('tax_return').select(COLS).where('id', '=', id).where('form_code', '=', FORM);
  if (forUpdate) q = q.forUpdate();
  const r = await q.executeTakeFirst();
  if (!r) throw new AppError('TAX_RETURN_NOT_FOUND', 'Không tìm thấy tờ khai', 404);
  return r as Row;
}
export const getCitReturn = async (trx: Trx, id: number): Promise<CitReturnDto> => dto(await rowOf(trx, id));
export async function listCitReturns(trx: Trx, year?: number): Promise<CitReturnDto[]> {
  let q = trx.selectFrom('tax_return').select(COLS).where('form_code', '=', FORM);
  if (year !== undefined) q = q.where('year', '=', year);
  return (await q.orderBy('year', 'desc').orderBy('revision', 'desc').execute()).map((r) => dto(r as Row));
}

export async function createCitReturn(trx: Trx, ctx: { tenantId: string; userId: string }, input: z.infer<typeof citReturnInput>) {
  await lock(trx, ctx.tenantId);
  const latest = await trx.selectFrom('tax_return').select(['id', 'revision', 'status', 'overrides']).where('form_code', '=', FORM).where('year', '=', input.year).where('period_kind', '=', 'year').where('period', '=', 1)
    .orderBy('revision', 'desc').executeTakeFirst();
  if (latest?.status === 'draft') throw new AppError('TAX_RETURN_DRAFT_EXISTS', `Năm này đã có tờ khai nháp${latest.revision ? ` bổ sung lần ${latest.revision}` : ''}: sửa hoặc chốt tờ khai đó`, 409, { id: latest.id });
  const revision = latest ? latest.revision + 1 : 0;
  if (input.revision !== undefined && input.revision !== revision) throw new AppError('TAX_RETURN_REVISION', revision === 0 ? 'Năm này chưa có tờ khai: lập lần đầu (revision 0)' : `Lần bổ sung tiếp theo của năm này là lần ${revision}`, 409);
  const overrides = input.overrides ?? ((latest?.overrides as Record<string, string> | undefined) ?? {}); // bổ sung: mặc định chép chỉ tiêu nhập tay của bản chốt gần nhất
  const c = await compute(trx, ctx.tenantId, input.year, overrides);
  const r = await trx.insertInto('tax_return').values({ tenant_id: ctx.tenantId, form_code: FORM, template_version: c.version, period_kind: 'year', year: input.year, period: 1, revision,
    values: JSON.stringify(c.values), overrides: JSON.stringify(overrides), created_by: ctx.userId }).returning('id').executeTakeFirstOrThrow()
    .catch((e: { code?: string; constraint?: string }) => { throw e.code === '23505' && e.constraint?.startsWith('tax_return_tenant_id_form_code') ? new AppError('TAX_RETURN_DRAFT_EXISTS', 'Năm này vừa có tờ khai được lập, tải lại danh sách', 409) : e; });
  return { ...(await getCitReturn(trx, r.id)), hints: c.hints, warnings: c.warnings };
}

async function draftOf(trx: Trx, tenantId: string, id: number): Promise<Row> {
  await lock(trx, tenantId);
  const r = await rowOf(trx, id, true);
  if (r.status === 'final') throw new AppError('TAX_RETURN_FINAL', 'Tờ khai đã chốt, không sửa được; lập tờ khai bổ sung', 409);
  return r;
}
// Sửa nháp: overrides gửi lên thay toàn bộ số nhập tay đã lưu, tính lại theo sổ hiện tại.
export async function updateCitReturn(trx: Trx, tenantId: string, id: number, input: z.infer<typeof citReturnUpdate>) {
  const r = await draftOf(trx, tenantId, id);
  const c = await compute(trx, tenantId, r.year, input.overrides);
  await trx.updateTable('tax_return').set({ template_version: c.version, values: JSON.stringify(c.values), overrides: JSON.stringify(input.overrides) }).where('id', '=', id).execute();
  return { ...(await getCitReturn(trx, id)), hints: c.hints, warnings: c.warnings };
}
export async function deleteCitReturn(trx: Trx, tenantId: string, id: number) {
  await draftOf(trx, tenantId, id);
  await trx.deleteFrom('tax_return').where('id', '=', id).execute();
}
// Chốt: tính lại theo sổ hiện tại, lệch số đã lưu thì 409 TAX_RETURN_STALE; có thu nhập tính thuế phổ thông mà chưa có thuế suất thì 409 CIT_RATE_REQUIRED.
export async function finalizeCitReturn(trx: Trx, ctx: { tenantId: string; userId: string }, id: number) {
  const r = await draftOf(trx, ctx.tenantId, id);
  const c = await compute(trx, ctx.tenantId, r.year, r.overrides);
  const changed = diffValues(r.values, c.values);
  if (changed.length || c.version !== r.template_version)
    throw new AppError('TAX_RETURN_STALE', `Số liệu sổ đã thay đổi kể từ lần tính trước (${changed.map((x) => `[${x.code}]`).join(', ') || 'mẫu tờ khai'}): lưu lại nháp để tính lại và kiểm tra trước khi chốt`, 409, { changed });
  if (c.values.C7a !== undefined && D(c.values.C7 ?? '0').gt(0) && D(c.values.C7a).isZero() && r.overrides.C7a === undefined)
    throw new AppError('CIT_RATE_REQUIRED', 'Chưa có thuế suất phổ thông (C7a) cho thu nhập tính thuế C7: nhập thuế suất trước khi chốt', 409);
  await trx.updateTable('tax_return').set({ status: 'final', finalized_by: ctx.userId, finalized_at: sql<string>`now()` }).where('id', '=', id).execute();
  return { ...(await getCitReturn(trx, id)), hints: c.hints, warnings: c.warnings };
}
// Gợi ý, cảnh báo, số lệch so với sổ hiện tại của nháp (chỉ đọc); đã chốt thì rỗng.
export async function previewCitReturn(trx: Trx, tenantId: string, id: number) {
  const r = await rowOf(trx, id);
  if (r.status === 'final') return { hints: {} as Record<string, string>, warnings: [] as string[], changed: [] as ReturnType<typeof diffValues> };
  const c = await compute(trx, tenantId, r.year, r.overrides);
  return { hints: c.hints, warnings: c.warnings, changed: diffValues(r.values, c.values) };
}

// XML tờ khai đã chốt (route tải XML và phiên ký số dùng chung). Gọi trong giao dịch đọc.
export async function renderCitXml(trx: Trx, tenantId: string, id: number): Promise<{ xml: string; file: string; verified: boolean }> {
  const fmt = XML_FORMATS['htkk-03tndn']!;
  const ret = await getCitReturn(trx, id); const company = await companyInfo(trx, tenantId, '', null);
  if (ret.status !== 'final') throw new AppError('TAX_RETURN_NOT_FINAL', 'Chỉ xuất XML tờ khai đã chốt', 409);
  if (!company.taxCode) throw new AppError('COMPANY_TAX_CODE_MISSING', 'Công ty chưa có mã số thuế: nhập ở Cài đặt công ty trước khi xuất XML', 409);
  const fy = await requireFiscalYear(trx, ret.year);
  const xml = fmt.render(ret, { name: company.name, taxCode: company.taxCode, address: company.address, legalRep: company.legalRep }, { from: fy.from, to: fy.to, label: `Năm ${ret.year}` });
  return { xml, file: `03TNDN_${company.taxCode}_N${ret.year}${ret.revision ? `-BS${ret.revision}` : ''}.xml`, verified: fmt.verified };
}
