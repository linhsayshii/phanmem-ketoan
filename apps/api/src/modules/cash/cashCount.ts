import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, Decimal, formatVnDate, formatVnNumber, VND_AMOUNT_MSG, VND_AMOUNT_RE, ZERO } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import * as S from '../ledger/vouchers.service.js';
import { regimeOf } from '../reporting/ledgers.js';
import { esc, printShell, type CompanyInfo } from '../reporting/print/voucherHtml.js';
import { cashBalanceAt } from './books.js';

type Trx = Transaction<Database>;
const isVnd = (currency: string) => currency === 'VND';

// Mệnh giá: số dương, tối đa 9 chữ số nguyên (VND không có phần lẻ); số lượng tối đa 100.000 tờ, tối đa 30 mệnh giá nên tổng luôn vừa numeric(20,4).
const denomination = z.object({ value: z.string().regex(/^\d{1,9}(\.\d{1,4})?$/, 'Mệnh giá không hợp lệ').refine((s) => Number(s) > 0, 'Mệnh giá phải lớn hơn 0'), qty: z.number().int().min(0).max(100_000) });
const member = z.object({ name: z.string().trim().min(1).max(200), role: z.string().trim().max(200).optional() });
export const countInput = z.object({
  countDate: S.dateIso, accountCode: z.string().min(1), currency: z.string().length(3).default('VND'),
  denominations: z.array(denomination).max(30).default([]), members: z.array(member).max(20).default([]), note: z.string().max(2000).optional(),
});
export const settleInput = z.object({
  accountCode: z.string().min(1).optional(),
  fxRate: z.string().regex(/^\d{1,10}(\.\d{1,10})?$/).refine((s) => Number(s) > 0, 'Tỷ giá phải lớn hơn 0').optional(),
});
export type CountInput = z.infer<typeof countInput>;
export type SettleInput = z.infer<typeof settleInput>;

export interface CashCountDto {
  id: number; countDate: string; accountCode: string; accountName: string; currency: string;
  bookBalance: string; bookBalanceCurrency: string | null; denominations: { value: string; qty: number }[]; countedTotal: string; difference: string;
  members: { name: string; role?: string }[]; note: string | null; voucherId: string | null; voucherNo: string | null; voucherState: string | null; createdAt: string;
}

// Lấy theo mã; RLS giấu kiểm kê của công ty khác nên cùng trả 404.
async function load(trx: Trx, id: number, lock = false): Promise<CashCountDto> {
  let q = trx.selectFrom('cash_count as c').innerJoin('account as a', 'a.id', 'c.account_id').leftJoin('voucher as v', 'v.id', 'c.voucher_id')
    .select(['c.id', 'c.count_date', 'a.code as account_code', 'a.name as account_name', 'c.currency_code', 'c.book_balance', 'c.book_balance_currency', 'c.denominations', 'c.counted_total', 'c.difference',
      'c.members', 'c.note', 'c.voucher_id', 'v.voucher_no', 'v.state as voucher_state', 'c.created_at']).where('c.id', '=', id);
  if (lock) q = q.forUpdate('c');
  const r = await q.executeTakeFirst();
  if (!r) throw new AppError('CASH_COUNT_NOT_FOUND', 'Không tìm thấy kiểm kê quỹ', 404);
  return dto(r);
}
function dto(r: { id: number | string; count_date: string; account_code: string; account_name: string; currency_code: string; book_balance: string; book_balance_currency: string; denominations: unknown; counted_total: string; difference: string;
  members: unknown; note: string | null; voucher_id: string | null; voucher_no: string | null; voucher_state: string | null; created_at: string }): CashCountDto {
  const vnd = isVnd(r.currency_code); const scale = vnd ? 0 : 4;
  return { id: Number(r.id), countDate: r.count_date, accountCode: r.account_code, accountName: r.account_name, currency: r.currency_code, bookBalance: D(r.book_balance).toFixed(0),
    bookBalanceCurrency: vnd ? null : D(r.book_balance_currency).toFixed(4), denominations: r.denominations as CashCountDto['denominations'], countedTotal: D(r.counted_total).toFixed(scale), difference: D(r.difference).toFixed(scale),
    members: r.members as CashCountDto['members'], note: r.note, voucherId: r.voucher_id, voucherNo: r.voucher_no, voucherState: r.voucher_state, createdAt: r.created_at };
}
export const getCount = (trx: Trx, id: number) => load(trx, id);
// shortcut: 200 kiểm kê gần nhất, thêm phân trang khi có công ty kiểm kê hằng ngày nhiều năm.
export async function listCounts(trx: Trx): Promise<CashCountDto[]> {
  const ids = await trx.selectFrom('cash_count').select('id').orderBy('count_date', 'desc').orderBy('id', 'desc').limit(200).execute();
  return Promise.all(ids.map((i) => load(trx, Number(i.id))));
}

export async function createCount(trx: Trx, ctx: { tenantId: string; userId: string }, input: CountInput): Promise<CashCountDto> {
  const regime = await regimeOf(trx, { from: input.countDate, to: input.countDate });
  const acc = await trx.selectFrom('account').select(['id', 'code', 'is_group', 'subledger_kind', 'track_currency']).where('regime', '=', regime).where('code', '=', input.accountCode).executeTakeFirst();
  if (!acc) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản ${input.accountCode}`, 404);
  // Chỉ tài khoản chi tiết của quỹ tiền mặt; kiểm kê ngoại tệ cần tài khoản theo dõi ngoại tệ.
  if (acc.is_group || acc.subledger_kind !== 'cash') throw new AppError('CASH_COUNT_ACCOUNT_INVALID', `Tài khoản ${acc.code} không phải tài khoản quỹ tiền mặt chi tiết`, 400);
  if (!isVnd(input.currency) && !acc.track_currency) throw new AppError('CASH_COUNT_ACCOUNT_INVALID', `Tài khoản ${acc.code} không theo dõi ngoại tệ`, 400);
  if (!(await trx.selectFrom('currency').select('code').where('code', '=', input.currency).executeTakeFirst())) throw new AppError('CURRENCY_NOT_FOUND', `Không có loại tiền ${input.currency}`, 404);
  if (isVnd(input.currency) && input.denominations.some((d) => !VND_AMOUNT_RE.test(d.value))) throw new AppError('VALIDATION', `Mệnh giá VND: ${VND_AMOUNT_MSG}`, 400);

  const book = await cashBalanceAt(trx, { accountCode: acc.code, currency: input.currency, asOf: input.countDate });
  const counted = input.denominations.reduce((t, d) => t.plus(D(d.value).times(d.qty)), ZERO);
  const bookInCurrency = D(book.balanceCurrency);
  const row = await trx.insertInto('cash_count').values({
    tenant_id: ctx.tenantId, count_date: input.countDate, account_id: acc.id, currency_code: input.currency, book_balance: book.balance, book_balance_currency: book.balanceCurrency,
    denominations: JSON.stringify(input.denominations), counted_total: counted.toFixed(4), difference: counted.minus(bookInCurrency).toFixed(4), members: JSON.stringify(input.members),
    note: input.note ?? null, created_by: ctx.userId,
  }).returning('id').executeTakeFirstOrThrow();
  return load(trx, Number(row.id));
}

// Chỉ xóa được kiểm kê chưa xử lý; kiểm kê đã có chứng từ xử lý giữ lại làm chứng từ gốc của phiếu đó.
export async function deleteCount(trx: Trx, id: number): Promise<void> {
  const c = await load(trx, id, true);
  if (c.voucherId) throw new AppError('CASH_COUNT_SETTLED', 'Kiểm kê đã có chứng từ xử lý chênh lệch, không xóa được', 409);
  await trx.deleteFrom('cash_count').where('id', '=', id).execute();
}

// Xử lý chênh lệch: thừa lập Phiếu thu (Nợ quỹ / Có 3381), thiếu lập Phiếu chi (Nợ 1381 / Có quỹ); phiếu ở trạng thái nháp, người dùng sửa và ghi sổ như phiếu thường.
// Kiểm kê chỉ xử lý một lần; chứng từ xử lý đã hủy thì được xử lý lại.
export async function settleCount(trx: Trx, ctx: { tenantId: string; userId: string }, id: number, input: SettleInput): Promise<CashCountDto> {
  const c = await load(trx, id, true);
  if (c.voucherId && c.voucherState !== 'cancelled') throw new AppError('CASH_COUNT_SETTLED', `Kiểm kê đã xử lý bằng chứng từ ${c.voucherNo ?? c.voucherId}`, 409);
  const diff = D(c.difference);
  if (diff.isZero()) throw new AppError('CASH_COUNT_NO_DIFFERENCE', 'Kiểm kê không có chênh lệch để xử lý', 400);
  const surplus = diff.gt(0); const foreign = !isVnd(c.currency);
  if (foreign && !input.fxRate) throw new AppError('FX_RATE_REQUIRED', `Quỹ ${c.currency}: nhập tỷ giá để quy đổi chênh lệch ra đồng`, 400);

  const regime = await regimeOf(trx, { from: c.countDate, to: c.countDate });
  const counterCode = input.accountCode ?? (surplus ? '3381' : '1381');
  const counter = await trx.selectFrom('account').select(['code', 'is_group']).where('regime', '=', regime).where('code', '=', counterCode).executeTakeFirst();
  if (!counter || counter.is_group || counter.code === c.accountCode)
    throw new AppError('CASH_COUNT_COUNTER_ACCOUNT_INVALID', `Tài khoản ${counterCode} không dùng được làm tài khoản đối ứng trong chế độ ${regime}; nhập tài khoản chi tiết khác (accountCode)`, 400);

  const abs = diff.abs();
  const vndAmount = (foreign ? abs.times(input.fxRate!).toDecimalPlaces(0, Decimal.ROUND_HALF_UP) : abs).toFixed(0);
  const cur = abs.toFixed(4);
  // Dòng quỹ nằm bên Nợ khi thừa (thu vào), bên Có khi thiếu (chi ra); amountCurrency mang dấu + bên Nợ, - bên Có.
  const line = (accountCode: string, debitSide: boolean) => ({ accountCode, debit: debitSide ? vndAmount : '0', credit: debitSide ? '0' : vndAmount, ...(foreign ? { amountCurrency: debitSide ? cur : `-${cur}` } : {}) });
  const v = await S.createVoucher(trx, ctx, {
    voucherType: surplus ? 'PT' : 'PC', postingDate: c.countDate, documentDate: c.countDate, currencyCode: c.currency, ...(foreign ? { fxRate: input.fxRate! } : {}),
    description: `Xử lý ${surplus ? 'quỹ thừa' : 'quỹ thiếu'} khi kiểm kê quỹ ngày ${formatVnDate(c.countDate)}`,
    lines: surplus ? [line(c.accountCode, true), line(counter.code, false)] : [line(counter.code, true), line(c.accountCode, false)],
  });
  // source_doc_id là uuid còn mã kiểm kê là số: lấy uuid xác định từ (công ty, kiểm kê), cùng cách số dư đầu kỳ làm với năm tài chính; mã kiểm kê nằm ở cash_count.voucher_id.
  await trx.updateTable('voucher').set({ source_doc_type: 'cash_count', source_doc_id: sql<string>`md5(${`${ctx.tenantId}:cash_count:${id}`})::uuid` }).where('id', '=', v.id).execute();
  await trx.updateTable('cash_count').set({ voucher_id: v.id }).where('id', '=', id).execute();
  return load(trx, id);
}

// ---- Bảng kiểm kê quỹ: mẫu 08a - TT (VND) và 08b - TT (ngoại tệ), chép từ TT 133/2016 và TT 99/2025; chế độ không có văn bản gốc thì in không có dòng "Mẫu số" (c.formNo rỗng). ----
export const DOTS = '……………………………';
export const sign = (cols: string[]) => `<div class="sign">${cols.map((s) => `<div><b>${s}</b><i>(Ký, họ tên)</i><div class="gap"></div></div>`).join('')}</div>`;
export const header = (c: CompanyInfo) => `<div class="head"><div>Đơn vị: <b>${esc(c.name)}</b><br>Địa chỉ: ${esc(c.address ?? '')}</div>`
  + `${c.formNo ? `<div style="text-align:right"><b>Mẫu số ${esc(c.formNo)}</b><br>${esc(c.issuedBy)}</div>` : ''}</div>`;
export const cell = (s: string | number, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${s}</td>`;

export function renderCashCountHtml(k: CashCountDto, c: CompanyInfo): string {
  const vnd = isVnd(k.currency); const scale = vnd ? 0 : 4;
  const [y, m, d] = k.countDate.split('-');
  // Mẫu ghi III = I - II (sổ trừ thực tế): dương là thiếu, âm là thừa; số kiểm kê ngoại tệ tính bằng nguyên tệ nên số sổ cũng lấy theo nguyên tệ.
  const book = vnd ? k.bookBalance : k.bookBalanceCurrency!;
  const iii = D(book).minus(D(k.countedTotal));
  const fmt = (v: string | Decimal) => formatVnNumber(v, scale);
  const people = k.members.length ? k.members.map((p) => `<p>- Ông/Bà: <b>${esc(p.name)}</b> &nbsp; Đại diện: ${p.role ? `<b>${esc(p.role)}</b>` : DOTS}</p>`).join('')
    : ['kế toán', 'thủ quỹ', DOTS].map((r) => `<p>- Ông/Bà: ${DOTS} &nbsp; Đại diện ${r}</p>`).join('');
  const lines = k.denominations.filter((x) => x.qty > 0);
  const head = vnd ? '<tr><th rowspan="2">STT</th><th rowspan="2">Diễn giải</th><th>Số lượng (tờ)</th><th>Số tiền</th></tr><tr><th>1</th><th>2</th></tr>'
    : '<tr><th rowspan="2">STT</th><th rowspan="2">Diễn giải</th><th rowspan="2">Đơn vị tính</th><th rowspan="2">Số lượng</th><th rowspan="2">Đơn giá</th><th colspan="2">Tính ra VNĐ</th><th rowspan="2">Ghi chú</th></tr><tr><th>Tỷ giá</th><th>VNĐ</th></tr>';
  const body = vnd
    ? `<tr>${cell('I')}${cell('Số dư theo sổ quỹ:')}${cell('')}${cell(fmt(book), 'num')}</tr>`
      + `<tr>${cell('II')}${cell('Số kiểm kê thực tế:')}${cell('')}${cell(fmt(k.countedTotal), 'num')}</tr>`
      + lines.map((x, i) => `<tr>${cell(i + 1)}${cell(`Trong đó: - Loại ${formatVnNumber(x.value)}`)}${cell(formatVnNumber(String(x.qty)), 'num')}${cell(fmt(D(x.value).times(x.qty)), 'num')}</tr>`).join('')
      + `<tr>${cell('III')}${cell('Chênh lệch (III = I - II):')}${cell('')}${cell(fmt(iii), 'num')}</tr>`
    : `<tr>${cell('I')}${cell('Số dư theo sổ quỹ:')}${cell(esc(k.currency))}${cell(fmt(book), 'num')}${cell('')}${cell('')}${cell(formatVnNumber(k.bookBalance), 'num')}${cell('')}</tr>`
      + `<tr>${cell('II')}${cell('Số kiểm kê thực tế (*):')}${cell(esc(k.currency))}${cell(fmt(k.countedTotal), 'num')}${cell('')}${cell('')}${cell('')}${cell('')}</tr>`
      + lines.map((x, i) => `<tr>${cell(i + 1)}${cell(`- Loại ${formatVnNumber(x.value, D(x.value).decimalPlaces())}`)}${cell(esc(k.currency))}${cell(formatVnNumber(String(x.qty)), 'num')}${cell(formatVnNumber(x.value, D(x.value).decimalPlaces()), 'num')}${cell('')}${cell('')}${cell('')}</tr>`).join('')
      + `<tr>${cell('III')}${cell('Chênh lệch (III = I - II)')}${cell(esc(k.currency))}${cell(fmt(iii), 'num')}${cell('')}${cell('')}${cell('')}${cell('')}</tr>`;
  const amount = (v: Decimal) => `<b>${fmt(v)}${vnd ? '' : ` ${esc(k.currency)}`}</b>`;
  const title = 'BẢNG KIỂM KÊ QUỸ';
  const html = `<div class="cv">${header(c)}
    <h1>${title}</h1><div class="sub">${vnd ? '(Dùng cho VNĐ)' : '(Dùng cho ngoại tệ)'}</div>
    <p>Số: <b>${k.id}</b> &nbsp; Tài khoản: <b>${esc(k.accountCode)} - ${esc(k.accountName)}</b></p>
    <p>Hôm nay, vào ….. giờ ….. ngày <b>${d}</b> tháng <b>${m}</b> năm <b>${y}</b></p>
    <p>Chúng tôi gồm:</p>${people}
    <p>Cùng tiến hành kiểm kê quỹ ${vnd ? 'tiền mặt' : 'ngoại tệ, vàng bạc...'} kết quả như sau:</p>
    <table class="grid"><thead>${head}</thead><tbody>${body}</tbody></table>
    ${vnd ? '' : '<p class="note">(*) Số lượng và đơn giá tính bằng nguyên tệ; cột Tỷ giá, VNĐ của số kiểm kê do kế toán điền khi quy đổi.</p>'}
    <p>- Lý do: ${k.note ? esc(k.note) : DOTS}</p>
    <p>&nbsp;&nbsp;+ Thừa: ${iii.lt(0) ? amount(iii.abs()) : DOTS}</p>
    <p>&nbsp;&nbsp;+ Thiếu: ${iii.gt(0) ? amount(iii) : DOTS}</p>
    <p>- Kết luận sau khi kiểm kê quỹ: ${DOTS}${DOTS}</p>
    ${sign(vnd ? ['Kế toán trưởng', 'Thủ quỹ', 'Người chịu trách nhiệm kiểm kê quỹ'] : ['Thủ quỹ', 'Kế toán trưởng', 'Người chịu trách nhiệm kiểm kê quỹ'])}</div>`;
  return printShell(`${title} ${formatVnDate(k.countDate)}`, html);
}
