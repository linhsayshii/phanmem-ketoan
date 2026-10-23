import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, evaluateReport, parseFormula, sum, ZERO, type AccountRef, type Decimal, type Expr, type ReportLineDef, type Resolver, type Side, type Source } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { assertSensitive, regimeOf } from './ledgers.js';
import { formNoFor } from './print/forms.js';
import { loanLongRows } from '../loans/stats.js';

type Trx = Transaction<Database>;
export const REPORT_NAMES: Record<string, Record<string, string>> = {
  B01: { TT99: 'Báo cáo tình hình tài chính', TT133: 'Báo cáo tình hình tài chính', TT200: 'Bảng cân đối kế toán' },
  B02: { TT99: 'Báo cáo kết quả hoạt động kinh doanh', TT133: 'Báo cáo kết quả hoạt động kinh doanh', TT200: 'Báo cáo kết quả hoạt động kinh doanh' },
  B03: { TT99: 'Báo cáo lưu chuyển tiền tệ (phương pháp trực tiếp)', TT133: 'Báo cáo lưu chuyển tiền tệ (phương pháp trực tiếp)', TT200: 'Báo cáo lưu chuyển tiền tệ (phương pháp trực tiếp)' },
};

// Sao chép mẫu hệ thống của `regime` vào báo cáo của công ty. `code` giới hạn một báo cáo: chỉ báo cáo đó bị xóa và dựng lại, báo cáo khác đã sửa của công ty được giữ.
// Không có mẫu (bộ chờ văn bản) thì không xóa gì và trả 0, định nghĩa hiện có của công ty còn nguyên.
export async function copyReportTemplates(trx: Trx, tenantId: string, regime: string, code?: string): Promise<number> {
  let q = trx.selectFrom('report_template').selectAll().where('regime', '=', regime);
  if (code) q = q.where('report_code', '=', code);
  const tpl = await q.orderBy('report_code').orderBy('sort_order').execute();
  for (const c of [...new Set(tpl.map((t) => t.report_code))]) {
    await trx.deleteFrom('report_def').where('tenant_id', '=', tenantId).where('regime', '=', regime).where('report_code', '=', c).execute(); // dòng đi theo qua ON DELETE CASCADE
    const f = formNoFor(regime, c);
    const def = await trx.insertInto('report_def').values({ tenant_id: tenantId, regime, report_code: c, name: REPORT_NAMES[c]?.[regime] ?? c, form_no: f.formNo, issued_by: f.issuedBy }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('report_line').values(tpl.filter((x) => x.report_code === c).map((t) => ({ tenant_id: tenantId, report_def_id: def.id, line_code: t.line_code, label: t.label, parent_line_code: t.parent_line_code,
      source: t.source, side: t.side, formula: t.formula, sort_order: t.sort_order, is_bold: t.is_bold, negate: t.negate, note_ref: t.note_ref }))).execute();
  }
  return tpl.length;
}

// ---- Dữ liệu sổ cái của một báo cáo ----
// Mỗi nguồn đọc đúng một lần cho cả báo cáo (không truy vấn lại cho từng hạng tử; fn_balances_at có thể phải quét sổ khi số dư kỳ đang bẩn), rồi từng hạng tử lọc theo tiền tố trong bộ nhớ.
// Mọi truy vấn lọc theo chế độ của báo cáo: một công ty giữ nhiều hệ tài khoản trùng mã nên tiền tố '511' không được quét sang hệ khác.
// long: phần dài hạn của số dư (chỉ khi báo cáo dùng LT(...)); đơn vị số dư khi đó tách thành phần ngắn hạn và phần dài hạn, mỗi phần lấy bên Nợ/Có riêng.
interface Unit { code: string; name: string; kind: string | null; partyCode: string | null; d: Decimal; c: Decimal; long?: true }
// cf: mã luồng tiền của cặp (mã của dòng Nợ, không có thì của dòng Có); cfSign +1 khi mã ở dòng Nợ (tiền vào), -1 khi ở dòng Có (tiền ra).
interface PairUnit { dcode: string; dname: string; dkind: string | null; ccode: string; cname: string; ckind: string | null; amount: Decimal; cf: string | null; cfSign: number }
const once = <T>(f: () => Promise<T>): (() => Promise<T>) => { let v: Promise<T> | undefined; return () => (v ??= f()); };

const unitOf = (r: { code: string; name: string; kind: string | null; partyCode: string | null }, n: Decimal, long: boolean): Unit =>
  ({ code: r.code, name: r.name, kind: r.kind, partyCode: r.partyCode, d: n.gt(0) ? n : ZERO, c: n.lt(0) ? n.neg() : ZERO, ...(long && { long: true as const }) });
// Phần dài hạn của tài khoản không theo khoản (vay, tiền gửi có kỳ hạn...) lấy từ hạn ở dòng: dòng trả nợ không ghi hạn trừ vào phần ngắn hạn trước,
// nên phần dài hạn cùng dấu với số dư và không vượt số dư.
const clampLong = (n: Decimal, l: Decimal): Decimal => (n.isZero() || l.isZero() || n.isNeg() !== l.isNeg() ? ZERO : l.abs().gt(n.abs()) ? n : l);
// Báo cáo dùng LT(...) (B01 TT99): mới đọc kỳ hạn, vì phải đọc thêm khoản công nợ và dòng có hạn.
export const usesLongTerm = (formulas: (string | null)[]) => formulas.some((f) => /LT\s*\(/.test(f ?? ''));

// Tài khoản tiền và tương đương tiền của cặp đối ứng: loại sổ chi tiết tiền mặt, tiền gửi, cộng 113 (tiền đang chuyển, không có loại sổ chi tiết) theo tiền tố như dòng 60, 70 của B03.
const CASH_SIDE = (a: 'ad' | 'ac') => sql.raw(`(coalesce(${a}.subledger_kind IN ('cash','bank'), false) OR ${a}.code LIKE '113%')`) // coalesce: loại NULL không được làm cả điều kiện thành NULL;
export const isCashLike = (a: { code: string; kind: string | null } | undefined) => !!a && (a.kind === 'cash' || a.kind === 'bank' || a.code.startsWith('113'));

export function reportData(trx: Trx, tenantId: string, regime: string, p: { from: string; to: string }, opts: { longTerm?: boolean } = {}) {
  // Phát sinh trong kỳ không gồm chứng từ kết chuyển (KC và bản đảo của KC mang cờ is_closing), nếu không doanh thu/chi phí về 0.
  // onlyReval: chỉ nhóm đánh giá lại ngoại tệ cuối kỳ = dòng của chứng từ DG (source_doc_type 'fx_revaluation', gồm bản đảo do chạy lại; DG của TT133 qua 413 rồi kết chuyển cũng cùng loại)
  // và của chứng từ CL sinh khi đảo khoản công nợ đã đánh giá lại (đối trừ kiểu 'reversal' kèm fx_voucher_id): CL đó gỡ chênh lệch đánh giá lại của chính khoản ấy. CL đối trừ thông thường ('fx') và XQ không thuộc nhóm.
  const movementRows = async (onlyReval: boolean): Promise<Unit[]> => (await sql<{ code: string; name: string; kind: string | null; d: string; c: string }>`
      SELECT a.code, a.name, a.subledger_kind AS kind, sum(l.debit)::text AS d, sum(l.credit)::text AS c
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND NOT v.is_closing AND a.regime = ${regime}
        AND v.posting_date BETWEEN ${p.from}::date AND ${p.to}::date AND l.posting_date BETWEEN ${p.from}::date AND ${p.to}::date
        ${onlyReval ? sql`AND (v.source_doc_type = 'fx_revaluation' OR v.id IN (SELECT s.fx_voucher_id FROM settlement s WHERE s.tenant_id = ${tenantId}::uuid AND s.kind = 'reversal' AND s.fx_voucher_id IS NOT NULL))` : sql``}
      GROUP BY a.id`.execute(trx)).rows.map((r) => ({ code: r.code, name: r.name, kind: r.kind, partyCode: null, d: D(r.d), c: D(r.c) }));
  return {
    // Đơn vị số dư: tài khoản công nợ theo từng đối tượng, tài khoản khác theo tài khoản; dư ròng gộp loại tiền. Nợ/Có của đơn vị là phần dư một bên.
    // Kỳ hạn (opts.longTerm): phần dài hạn = kỳ hạn còn lại trên 12 tháng kể từ ngày báo cáo. Tài khoản công nợ theo hạn thanh toán của từng khoản còn dư (open_item.due_date) tại ngày báo cáo,
    // không chặn theo số dư (khoản dài hạn và khoản trả trước ngắn hạn của cùng đối tượng trình bày riêng hai bên); tài khoản khác theo hạn ghi ở dòng (voucher_line.due_date, ngày đáo hạn), chặn bởi clampLong.
    balance: once(async (): Promise<Unit[]> => {
      const base = (await sql<{ code: string; name: string; kind: string | null; partyCode: string | null; net: string }>`
      SELECT a.code, a.name, a.subledger_kind AS kind, pt.code AS "partyCode", x.n::text AS net FROM (
        SELECT a.id, CASE WHEN a.subledger_kind IN ('receivable','payable') THEN b.party_id END AS party_id, sum(b.debit - b.credit) AS n
        FROM fn_balances_at(${tenantId}::uuid, ${p.to}::date) b JOIN account a ON a.id = b.account_id WHERE a.regime = ${regime}
        GROUP BY 1, 2 HAVING sum(b.debit - b.credit) <> 0) x
      JOIN account a ON a.id = x.id LEFT JOIN party pt ON pt.id = x.party_id`.execute(trx)).rows;
      if (!opts.longTerm) return base.map((r) => unitOf(r, D(r.net), false));
      const cutoff = shiftYear(p.to, 1);
      const long = [...(await sql<{ code: string; name: string; kind: string | null; partyCode: string | null; net: string }>`
      SELECT a.code, a.name, a.subledger_kind AS kind, pt.code AS "partyCode", x.n::text AS net FROM (
        SELECT o.account_id AS id, o.party_id, sum(o.residual) AS n FROM fn_open_items_at(${tenantId}::uuid, ${p.to}::date) o
        WHERE o.due_date > ${cutoff}::date GROUP BY 1, 2
        UNION ALL
        SELECT l.account_id, NULL::uuid, sum(l.debit - l.credit) FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
        WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND l.posting_date <= ${p.to}::date AND l.due_date > ${cutoff}::date
          AND a.subledger_kind IS DISTINCT FROM 'receivable' AND a.subledger_kind IS DISTINCT FROM 'payable'
          -- gốc vay của khế ước vay tách theo lịch trả (loanLongRows), không theo hạn ghi ở dòng
          AND NOT EXISTS (SELECT 1 FROM loan_term lt WHERE lt.tenant_id = l.tenant_id AND lt.contract_id = l.contract_id AND lt.principal_account_code = a.code) GROUP BY 1) x
      JOIN account a ON a.id = x.id LEFT JOIN party pt ON pt.id = x.party_id WHERE a.regime = ${regime} AND x.n <> 0`.execute(trx)).rows, ...await loanLongRows(trx, p.to, regime)];
      const key = (r: { code: string; partyCode: string | null }) => `${r.code}|${r.partyCode ?? ''}`;
      const rows = new Map(base.map((r) => [key(r), { r, n: D(r.net), l: ZERO }]));
      for (const r of long) { const k = key(r); const x = rows.get(k); if (x) x.l = x.l.plus(r.net); else rows.set(k, { r, n: ZERO, l: D(r.net) }); }
      return [...rows.values()].flatMap(({ r, n, l }) => {
        const lt = r.kind === 'receivable' || r.kind === 'payable' ? l : clampLong(n, l);
        return [unitOf(r, n.minus(lt), false), ...(lt.isZero() ? [] : [unitOf(r, lt, true)])];
      });
    }),
    movement: once(() => movementRows(false)),
    reval: once(() => movementRows(true)),
    // Đối ứng gồm cả chứng từ kết chuyển; cả hai tài khoản của cặp phải thuộc chế độ của báo cáo.
    // Mã luồng tiền đọc từ hai dòng của cặp (cùng posting_date với cặp: chỉ quét partition của tháng).
    pair: once(async (): Promise<PairUnit[]> => (await sql<{ dcode: string; dname: string; dkind: string | null; ccode: string; cname: string; ckind: string | null; amount: string; cf: string | null; cfSign: number }>`
      SELECT ad.code AS dcode, ad.name AS dname, ad.subledger_kind AS dkind, ac.code AS ccode, ac.name AS cname, ac.subledger_kind AS ckind, sum(p.amount)::text AS amount,
             -- Cặp tiền sang tiền (chuyển tiền nội bộ, hoặc cặp do ghép nhiều Nợ nhiều Có tạo ra) không phải luồng tiền: bỏ mã, như dòng 60 triệt tiêu cặp đó.
             CASE WHEN NOT (${CASH_SIDE('ad')} AND ${CASH_SIDE('ac')}) THEN coalesce(dl.cash_flow_code, cl.cash_flow_code) END AS cf,
             CASE WHEN dl.cash_flow_code IS NOT NULL THEN 1 ELSE -1 END AS "cfSign"
      FROM voucher_pair p JOIN voucher v ON v.id = p.voucher_id JOIN account ad ON ad.id = p.debit_account_id JOIN account ac ON ac.id = p.credit_account_id
        LEFT JOIN voucher_line dl ON dl.id = p.debit_line_id AND dl.posting_date = p.posting_date LEFT JOIN voucher_line cl ON cl.id = p.credit_line_id AND cl.posting_date = p.posting_date
      WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND ad.regime = ${regime} AND ac.regime = ${regime}
        AND p.posting_date BETWEEN ${p.from}::date AND ${p.to}::date
      GROUP BY ad.id, ac.id, 8, 9`.execute(trx)).rows.map((r) => ({ ...r, amount: D(r.amount) }))),
  };
}
type ReportData = ReturnType<typeof reportData>;
const underAny = (code: string, prefixes: string[]) => prefixes.some((x) => code.startsWith(x));
const matches = (code: string, ref: { prefix: string; exclude: string[] }) => code.startsWith(ref.prefix) && !underAny(code, ref.exclude);
const pick = (side: Side, u: { d: Decimal; c: Decimal }): Decimal => side === 'debit' ? u.d : side === 'credit' ? u.c : side === 'net_debit' ? u.d.minus(u.c) : u.c.minus(u.d);
const pairMatches = (r: PairUnit, debit: string[], credit: string[], excludeCoded?: true) => underAny(r.dcode, debit) && underAny(r.ccode, credit) && !(excludeCoded && r.cf !== null);
const matchesAny = (code: string, refs: AccountRef[]) => refs.some((r) => matches(code, r));

// Đơn vị phát sinh sau khi trừ nhóm đánh giá lại (hậu tố !REVAL); đơn vị chỉ gồm nhóm đó còn Nợ = Có = 0, giữ lại vì cộng 0 không đổi số.
async function movementWithoutReval(data: ReportData): Promise<Unit[]> {
  const rv = new Map((await data.reval()).map((u) => [u.code, u]));
  return (await data.movement()).map((u) => { const r = rv.get(u.code); return r ? { ...u, d: u.d.minus(r.d), c: u.c.minus(r.c) } : u; });
}
// Số thuần đánh giá lại: N = Σ(Có − Nợ) của 515 − Σ(Nợ − Có) của 635 trong nhóm; lãi thuần = max(N, 0), lỗ thuần = max(−N, 0).
export const REVAL_GAIN_PREFIX = '515'; export const REVAL_LOSS_PREFIX = '635';
async function netReval(data: ReportData): Promise<{ gain: Decimal; loss: Decimal }> {
  const us = await data.reval();
  const n = sum(us.filter((u) => u.code.startsWith(REVAL_GAIN_PREFIX)).map((u) => u.c.minus(u.d))).minus(sum(us.filter((u) => u.code.startsWith(REVAL_LOSS_PREFIX)).map((u) => u.d.minus(u.c))));
  return { gain: n.gt(0) ? n : ZERO, loss: n.lt(0) ? n.neg() : ZERO };
}

export function sqlResolver(data: ReportData): Resolver {
  return {
    async account(ref, source, side) { return sum((ref.excludeReval ? await movementWithoutReval(data) : await data[source]()).filter((u) => matches(u.code, ref)).map((u) => pick(side, u))); },
    async pair(debit, credit, o) { return sum((await data.pair()).filter((r) => pairMatches(r, debit, credit, o?.excludeCoded)).map((r) => r.amount)); },
    reval: () => netReval(data),
    async longTerm(refs, side) { return sum((await data.balance()).filter((u) => u.long && matchesAny(u.code, refs)).map((u) => pick(side, u))); },
    async cashFlow(code) { return sum((await data.pair()).filter((r) => r.cf === code).map((r) => r.amount.times(r.cfSign))); },
  };
}

async function loadDef(trx: Trx, reportCode: string, regime: string) {
  const def = await trx.selectFrom('report_def').selectAll().where('report_code', '=', reportCode).where('regime', '=', regime).executeTakeFirst();
  if (!def) throw new AppError('REPORT_NOT_FOUND', `Chưa có định nghĩa báo cáo ${reportCode} cho ${regime}; hãy định nghĩa trong Sửa công thức hoặc Nạp lại mẫu`, 404);
  const lines = await trx.selectFrom('report_line').selectAll().where('report_def_id', '=', def.id).orderBy('sort_order').execute();
  return { def, lines };
}

const dayBeforeIso = (iso: string) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
// Lùi/tiến n năm giữ nguyên tháng ngày; 29/2 về 28/2 ở năm không nhuận.
export const shiftYear = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]; const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
  return `${String(y + n).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};
// Ngày đầu năm tài chính chứa `date`.
async function yearStartOf(trx: Trx, date: string): Promise<string> {
  const p = await trx.selectFrom('fiscal_period').select('fiscal_year').where('period_no', '>=', 1).where('date_from', '<=', date).where('date_to', '>=', date).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Ngày ${date} không thuộc năm tài chính nào`, 404);
  return (await trx.selectFrom('fiscal_period').select('date_from').where('fiscal_year', '=', p.fiscal_year).where('period_no', '=', 1).executeTakeFirstOrThrow()).date_from;
}

// Chế độ của kỳ chứa `date` (kỳ thường đứng trước kỳ 0 trùng ngày cuối năm, cùng cách chọn với fn_balances_at); null khi không kỳ nào chứa.
async function regimeAt(trx: Trx, date: string): Promise<string | null> {
  const r = await sql<{ regime: string }>`SELECT regime FROM fiscal_period WHERE date_from <= ${date}::date AND date_to >= ${date}::date ORDER BY period_no = 0, fiscal_year DESC, period_no DESC LIMIT 1`.execute(trx);
  return r.rows[0]?.regime ?? null;
}

export async function evaluateFinancialReport(trx: Trx, tenantId: string, q: { reportCode: string; from: string; to: string; comparePrevYear: boolean }) {
  const regime = await regimeOf(trx, q);
  const { def, lines } = await loadDef(trx, q.reportCode, regime);
  const defs: ReportLineDef[] = lines.map((l) => ({ lineCode: l.line_code, formula: l.formula, source: l.source as Source, side: l.side as Side }));
  const longTerm = usesLongTerm(lines.map((l) => l.formula));
  const run = (from: string, to: string) => evaluateReport(defs, sqlResolver(reportData(trx, tenantId, regime, { from, to }, { longTerm })));
  const current = await run(q.from, q.to);
  // B01: cột so sánh là "số đầu năm" = dư tại ngày trước ngày đầu năm tài chính chứa `to` (gồm DK kỳ 0); B02/B03: cùng kỳ năm trước khi được yêu cầu.
  const compareTo = q.reportCode === 'B01' ? dayBeforeIso(await yearStartOf(trx, q.to)) : q.comparePrevYear ? shiftYear(q.to, -1) : null;
  // Ngày so sánh thuộc kỳ của chế độ khác (đổi chế độ giữa hai năm): số của hệ tài khoản kia không cộng vào chỉ tiêu của hệ này, nên để trống thay vì hiện 0 sai.
  // Chưa có chức năng chuyển đổi số dư giữa hai hệ tài khoản; ngày không thuộc kỳ nào (năm đầu tiên) thì không có số liệu, vẫn là 0.
  const prevRegime = compareTo === null ? null : await regimeAt(trx, compareTo);
  const changed = prevRegime !== null && prevRegime !== regime;
  const previous = compareTo === null || changed ? null : await run(q.reportCode === 'B01' ? q.from : shiftYear(q.from, -1), compareTo);
  return { reportCode: def.report_code, name: def.name, formNo: def.form_no, issuedBy: def.issued_by, regime, period: { from: q.from, to: q.to }, ...(changed && { previousNote: 'REGIME_CHANGED' as const }),
    rows: lines.map((l) => ({ lineCode: l.line_code, label: l.label, parentLineCode: l.parent_line_code, isBold: l.is_bold, negate: l.negate, noteRef: l.note_ref, source: l.source, formula: l.formula,
      current: (current.get(l.line_code) ?? ZERO).toString(), previous: previous ? (previous.get(l.line_code) ?? ZERO).toString() : null })) };
}

// Các hạng tử tài khoản/đối ứng của công thức kèm dấu (+1/-1); số và dòng [x] không có tài khoản trực tiếp nên bỏ qua.
function signedTerms(e: Expr, sign = 1): { sign: number; term: Expr }[] {
  if (e.kind === 'bin') return [...signedTerms(e.left, sign), ...signedTerms(e.right, e.op === '-' ? -sign : sign)];
  return e.kind === 'account' || e.kind === 'pair' || e.kind === 'reval' || e.kind === 'lt' || e.kind === 'cf' ? [{ sign, term: e }] : [];
}

// Truy ngược cấp 1: các đơn vị (tài khoản, đối tượng; hoặc cặp Nợ/Có với nguồn đối ứng) tạo nên chỉ tiêu, dùng đúng dữ liệu, tiền tố, loại trừ và dấu của công thức nên cộng lại bằng giá trị chỉ tiêu.
// Dòng tổng hợp chỉ gồm [x] không có tài khoản trực tiếp: trả rỗng, người dùng truy ngược từng dòng thành phần.
interface DrillRow { kind?: 'reval_net'; accountCode: string; accountName: string; counterAccountCode?: string; partyCode: string | null; amount: Decimal; checks: { code: string; kind: string | null }[] }
export async function drillLine(trx: Trx, tenantId: string, q: { reportCode: string; lineCode: string; from: string; to: string }, auth: { sensitive: Set<string> }) {
  const regime = await regimeOf(trx, q);
  const { lines } = await loadDef(trx, q.reportCode, regime);
  const l = lines.find((x) => x.line_code === q.lineCode);
  if (!l) throw new AppError('REPORT_LINE_NOT_FOUND', `Báo cáo ${q.reportCode} không có dòng ${q.lineCode}`, 404);
  if (!l.formula?.trim()) return { accounts: [] };
  const data = reportData(trx, tenantId, regime, q, { longTerm: usesLongTerm([l.formula]) }); const side = l.side as Side;
  const rows = new Map<string, DrillRow>();
  const add = (key: string, row: Omit<DrillRow, 'amount'>, amount: Decimal) => rows.set(key, { ...row, amount: (rows.get(key)?.amount ?? ZERO).plus(amount) });
  for (const { sign, term } of signedTerms(parseFormula(l.formula))) {
    if (term.kind === 'account') {
      for (const u of term.excludeReval ? await movementWithoutReval(data) : await data[l.source === 'movement' ? 'movement' : 'balance']()) if (matches(u.code, term))
        add(`${u.code}|${u.partyCode ?? ''}`, { accountCode: u.code, accountName: u.name, partyCode: u.partyCode, checks: [{ code: u.code, kind: u.kind }] }, pick(side, u).times(sign));
    } else if (term.kind === 'reval') {
      // Số thuần đánh giá lại là một con số của cả nhóm, không tách theo tài khoản: một dòng kind 'reval_net' mang mã 515 (lãi) hoặc 635 (lỗ), khác dòng tài khoản 515/635 thật.
      const net = await netReval(data); const gain = term.side === 'gain';
      add(`REVAL|${term.side}`, { kind: 'reval_net', accountCode: gain ? REVAL_GAIN_PREFIX : REVAL_LOSS_PREFIX, accountName: `Chênh lệch đánh giá lại ngoại tệ cuối kỳ (${gain ? 'lãi' : 'lỗ'} thuần)`, partyCode: null, checks: [] }, (gain ? net.gain : net.loss).times(sign));
    } else if (term.kind === 'lt') {
      for (const u of await data.balance()) if (u.long && matchesAny(u.code, term.refs))
        add(`${u.code}|${u.partyCode ?? ''}`, { accountCode: u.code, accountName: u.name, partyCode: u.partyCode, checks: [{ code: u.code, kind: u.kind }] }, pick(side, u).times(sign));
    } else if (term.kind === 'pair' || term.kind === 'cf') {
      // Cặp có mã luồng tiền: theo dấu tiền vào/ra của mã (CF), cùng khóa với cặp không mã nên cặp cùng tài khoản gộp một dòng.
      for (const r of await data.pair()) if (term.kind === 'cf' ? r.cf === term.code : pairMatches(r, term.debit, term.credit, term.excludeCoded))
        add(`${r.dcode}|${r.ccode}`, { accountCode: r.dcode, accountName: r.dname, counterAccountCode: r.ccode, partyCode: null, checks: [{ code: r.dcode, kind: r.dkind }, { code: r.ccode, kind: r.ckind }] }, r.amount.times(term.kind === 'cf' ? sign * r.cfSign : sign));
    }
  }
  const out = [...rows.values()].filter((r) => !r.amount.isZero())
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode) || (a.partyCode ?? '').localeCompare(b.partyCode ?? '') || (a.counterAccountCode ?? '').localeCompare(b.counterAccountCode ?? ''));
  // Danh sách theo đối tượng/tài khoản tiết lộ công nợ và giá vốn từng bên: cùng cờ nhạy cảm với sổ sách.
  for (const r of out) for (const c of r.checks) assertSensitive(auth, { subledger_kind: c.kind, code: c.code });
  return { accounts: out.map((r) => ({ ...(r.kind && { kind: r.kind }), accountCode: r.accountCode, accountName: r.accountName, ...(r.counterAccountCode !== undefined && { counterAccountCode: r.counterAccountCode }), partyCode: r.partyCode, amount: r.amount.toString() })) };
}

export interface ReportLineInput { lineCode: string; label: string; parentLineCode: string | null; source: Source; side: Side; formula: string | null; isBold: boolean; negate: boolean; noteRef: string | null }

// Lưu toàn bộ dòng của một báo cáo. Kiểm tra trước khi ghi: cú pháp công thức, dòng [x] tồn tại, không vòng lặp (chạy thử với bộ giải trả 0), mã dòng không trùng, dòng cha tồn tại.
export async function saveReportDef(trx: Trx, tenantId: string, regime: string, reportCode: string, lines: ReportLineInput[]): Promise<void> {
  await evaluateReport(lines.map((l) => ({ lineCode: l.lineCode, formula: l.formula, source: l.source, side: l.side })), { account: async () => ZERO, pair: async () => ZERO, reval: async () => ({ gain: ZERO, loss: ZERO }), longTerm: async () => ZERO, cashFlow: async () => ZERO });
  const codes = new Set(lines.map((l) => l.lineCode));
  if (codes.size !== lines.length) throw new AppError('VALIDATION', 'Mã dòng bị trùng', 400);
  for (const l of lines) if (l.parentLineCode && !codes.has(l.parentLineCode)) throw new AppError('VALIDATION', `Dòng ${l.lineCode}: không có dòng cha ${l.parentLineCode}`, 400);
  // Chuỗi dòng cha không được quay về chính dòng đang xét (dòng tự làm cha của mình hoặc vòng A -> B -> A): thụt lề theo cha sẽ không dừng.
  const parentOf = new Map(lines.map((l) => [l.lineCode, l.parentLineCode]));
  for (const l of lines) for (let seen = new Set([l.lineCode]), p = l.parentLineCode; p; p = parentOf.get(p) ?? null) {
    if (seen.has(p)) throw new AppError('VALIDATION', `Dòng ${l.lineCode}: dòng cha tạo vòng lặp`, 400);
    seen.add(p);
  }
  const f = formNoFor(regime, reportCode);
  const d = await trx.insertInto('report_def').values({ tenant_id: tenantId, regime, report_code: reportCode, name: REPORT_NAMES[reportCode]?.[regime] ?? reportCode, form_no: f.formNo, issued_by: f.issuedBy })
    .onConflict((oc) => oc.columns(['tenant_id', 'regime', 'report_code']).doUpdateSet({ name: sql`report_def.name` })).returning('id').executeTakeFirstOrThrow(); // cập nhật giả để RETURNING trả id của định nghĩa đã có
  await trx.deleteFrom('report_line').where('report_def_id', '=', d.id).execute();
  if (lines.length) await trx.insertInto('report_line').values(lines.map((l, i) => ({ tenant_id: tenantId, report_def_id: d.id, line_code: l.lineCode, label: l.label, parent_line_code: l.parentLineCode, source: l.source, side: l.side,
    formula: l.formula, sort_order: i + 1, is_bold: l.isBold, negate: l.negate, note_ref: l.noteRef }))).execute();
}

// Danh mục mã luồng tiền của chế độ: các dòng luồng tiền (nguồn đối ứng, có dòng cha) của định nghĩa B03 của công ty; công ty chưa có B03 thì rỗng.
export async function cashFlowCodes(trx: Trx, regime: string): Promise<{ code: string; name: string }[]> {
  return trx.selectFrom('report_line as l').innerJoin('report_def as d', 'd.id', 'l.report_def_id').select(['l.line_code as code', 'l.label as name'])
    .where('d.report_code', '=', 'B03').where('d.regime', '=', regime).where('l.source', '=', 'pair').where('l.parent_line_code', 'is not', null).orderBy('l.sort_order').execute();
}
