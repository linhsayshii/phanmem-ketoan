import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, evaluateReport, parseFormula, sum, ZERO, type Decimal, type Expr, type ReportLineDef, type Resolver, type Side, type Source } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { assertSensitive, regimeOf } from './ledgers.js';
import { formNoFor } from './print/forms.js';

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
interface Unit { code: string; name: string; kind: string | null; partyCode: string | null; d: Decimal; c: Decimal }
interface PairUnit { dcode: string; dname: string; dkind: string | null; ccode: string; cname: string; ckind: string | null; amount: Decimal }
const once = <T>(f: () => Promise<T>): (() => Promise<T>) => { let v: Promise<T> | undefined; return () => (v ??= f()); };

function reportData(trx: Trx, tenantId: string, regime: string, p: { from: string; to: string }) {
  return {
    // Đơn vị số dư: tài khoản công nợ theo từng đối tượng, tài khoản khác theo tài khoản; dư ròng gộp loại tiền. Nợ/Có của đơn vị là phần dư một bên.
    balance: once(async (): Promise<Unit[]> => (await sql<{ code: string; name: string; kind: string | null; partyCode: string | null; net: string }>`
      SELECT a.code, a.name, a.subledger_kind AS kind, pt.code AS "partyCode", x.n::text AS net FROM (
        SELECT a.id, CASE WHEN a.subledger_kind IN ('receivable','payable') THEN b.party_id END AS party_id, sum(b.debit - b.credit) AS n
        FROM fn_balances_at(${tenantId}::uuid, ${p.to}::date) b JOIN account a ON a.id = b.account_id WHERE a.regime = ${regime}
        GROUP BY 1, 2 HAVING sum(b.debit - b.credit) <> 0) x
      JOIN account a ON a.id = x.id LEFT JOIN party pt ON pt.id = x.party_id`.execute(trx)).rows.map((r) => { const n = D(r.net); return { code: r.code, name: r.name, kind: r.kind, partyCode: r.partyCode, d: n.gt(0) ? n : ZERO, c: n.lt(0) ? n.neg() : ZERO }; })),
    // Phát sinh trong kỳ không gồm chứng từ kết chuyển (KC và bản đảo của KC mang cờ is_closing), nếu không doanh thu/chi phí về 0.
    movement: once(async (): Promise<Unit[]> => (await sql<{ code: string; name: string; kind: string | null; d: string; c: string }>`
      SELECT a.code, a.name, a.subledger_kind AS kind, sum(l.debit)::text AS d, sum(l.credit)::text AS c
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND NOT v.is_closing AND a.regime = ${regime}
        AND v.posting_date BETWEEN ${p.from}::date AND ${p.to}::date AND l.posting_date BETWEEN ${p.from}::date AND ${p.to}::date
      GROUP BY a.id`.execute(trx)).rows.map((r) => ({ code: r.code, name: r.name, kind: r.kind, partyCode: null, d: D(r.d), c: D(r.c) }))),
    // Đối ứng gồm cả chứng từ kết chuyển; cả hai tài khoản của cặp phải thuộc chế độ của báo cáo.
    pair: once(async (): Promise<PairUnit[]> => (await sql<{ dcode: string; dname: string; dkind: string | null; ccode: string; cname: string; ckind: string | null; amount: string }>`
      SELECT ad.code AS dcode, ad.name AS dname, ad.subledger_kind AS dkind, ac.code AS ccode, ac.name AS cname, ac.subledger_kind AS ckind, sum(p.amount)::text AS amount
      FROM voucher_pair p JOIN voucher v ON v.id = p.voucher_id JOIN account ad ON ad.id = p.debit_account_id JOIN account ac ON ac.id = p.credit_account_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.state IN ('posted','reversed') AND ad.regime = ${regime} AND ac.regime = ${regime}
        AND p.posting_date BETWEEN ${p.from}::date AND ${p.to}::date
      GROUP BY ad.id, ac.id`.execute(trx)).rows.map((r) => ({ ...r, amount: D(r.amount) }))),
  };
}
type ReportData = ReturnType<typeof reportData>;
const underAny = (code: string, prefixes: string[]) => prefixes.some((x) => code.startsWith(x));
const matches = (code: string, ref: { prefix: string; exclude: string[] }) => code.startsWith(ref.prefix) && !underAny(code, ref.exclude);
const pick = (side: Side, u: { d: Decimal; c: Decimal }): Decimal => side === 'debit' ? u.d : side === 'credit' ? u.c : side === 'net_debit' ? u.d.minus(u.c) : u.c.minus(u.d);
const pairMatches = (r: PairUnit, debit: string[], credit: string[]) => underAny(r.dcode, debit) && underAny(r.ccode, credit);

function sqlResolver(data: ReportData): Resolver {
  return {
    async account(ref, source, side) { return sum((await data[source]()).filter((u) => matches(u.code, ref)).map((u) => pick(side, u))); },
    async pair(debit, credit) { return sum((await data.pair()).filter((r) => pairMatches(r, debit, credit)).map((r) => r.amount)); },
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
const shiftYear = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]; const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
  return `${String(y + n).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};
// Ngày đầu năm tài chính chứa `date`.
async function yearStartOf(trx: Trx, date: string): Promise<string> {
  const p = await trx.selectFrom('fiscal_period').select('fiscal_year').where('period_no', '>=', 1).where('date_from', '<=', date).where('date_to', '>=', date).executeTakeFirst();
  if (!p) throw new AppError('PERIOD_NOT_FOUND', `Ngày ${date} không thuộc năm tài chính nào`, 404);
  return (await trx.selectFrom('fiscal_period').select('date_from').where('fiscal_year', '=', p.fiscal_year).where('period_no', '=', 1).executeTakeFirstOrThrow()).date_from;
}

export async function evaluateFinancialReport(trx: Trx, tenantId: string, q: { reportCode: string; from: string; to: string; comparePrevYear: boolean }) {
  const regime = await regimeOf(trx, q);
  const { def, lines } = await loadDef(trx, q.reportCode, regime);
  const defs: ReportLineDef[] = lines.map((l) => ({ lineCode: l.line_code, formula: l.formula, source: l.source as Source, side: l.side as Side }));
  const run = (from: string, to: string) => evaluateReport(defs, sqlResolver(reportData(trx, tenantId, regime, { from, to })));
  const current = await run(q.from, q.to);
  // B01: cột so sánh là "số đầu năm" = dư tại ngày trước ngày đầu năm tài chính chứa `to` (gồm DK kỳ 0); B02/B03: cùng kỳ năm trước khi được yêu cầu.
  const previous = q.reportCode === 'B01' ? await run(q.from, dayBeforeIso(await yearStartOf(trx, q.to))) : q.comparePrevYear ? await run(shiftYear(q.from, -1), shiftYear(q.to, -1)) : null;
  return { reportCode: def.report_code, name: def.name, formNo: def.form_no, issuedBy: def.issued_by, regime, period: { from: q.from, to: q.to },
    rows: lines.map((l) => ({ lineCode: l.line_code, label: l.label, parentLineCode: l.parent_line_code, isBold: l.is_bold, negate: l.negate, noteRef: l.note_ref, source: l.source, formula: l.formula,
      current: (current.get(l.line_code) ?? ZERO).toString(), previous: previous ? (previous.get(l.line_code) ?? ZERO).toString() : null })) };
}

// Các hạng tử tài khoản/đối ứng của công thức kèm dấu (+1/-1); số và dòng [x] không có tài khoản trực tiếp nên bỏ qua.
function signedTerms(e: Expr, sign = 1): { sign: number; term: Expr }[] {
  if (e.kind === 'bin') return [...signedTerms(e.left, sign), ...signedTerms(e.right, e.op === '-' ? -sign : sign)];
  return e.kind === 'account' || e.kind === 'pair' ? [{ sign, term: e }] : [];
}

// Truy ngược cấp 1: các đơn vị (tài khoản, đối tượng; hoặc cặp Nợ/Có với nguồn đối ứng) tạo nên chỉ tiêu, dùng đúng dữ liệu, tiền tố, loại trừ và dấu của công thức nên cộng lại bằng giá trị chỉ tiêu.
// Dòng tổng hợp chỉ gồm [x] không có tài khoản trực tiếp: trả rỗng, người dùng truy ngược từng dòng thành phần.
interface DrillRow { accountCode: string; accountName: string; counterAccountCode?: string; partyCode: string | null; amount: Decimal; checks: { code: string; kind: string | null }[] }
export async function drillLine(trx: Trx, tenantId: string, q: { reportCode: string; lineCode: string; from: string; to: string }, auth: { sensitive: Set<string> }) {
  const regime = await regimeOf(trx, q);
  const { lines } = await loadDef(trx, q.reportCode, regime);
  const l = lines.find((x) => x.line_code === q.lineCode);
  if (!l) throw new AppError('REPORT_LINE_NOT_FOUND', `Báo cáo ${q.reportCode} không có dòng ${q.lineCode}`, 404);
  if (!l.formula?.trim()) return { accounts: [] };
  const data = reportData(trx, tenantId, regime, q); const side = l.side as Side;
  const rows = new Map<string, DrillRow>();
  const add = (key: string, row: Omit<DrillRow, 'amount'>, amount: Decimal) => rows.set(key, { ...row, amount: (rows.get(key)?.amount ?? ZERO).plus(amount) });
  for (const { sign, term } of signedTerms(parseFormula(l.formula))) {
    if (term.kind === 'account') {
      for (const u of await data[l.source === 'movement' ? 'movement' : 'balance']()) if (matches(u.code, term))
        add(`${u.code}|${u.partyCode ?? ''}`, { accountCode: u.code, accountName: u.name, partyCode: u.partyCode, checks: [{ code: u.code, kind: u.kind }] }, pick(side, u).times(sign));
    } else if (term.kind === 'pair') {
      for (const r of await data.pair()) if (pairMatches(r, term.debit, term.credit))
        add(`${r.dcode}|${r.ccode}`, { accountCode: r.dcode, accountName: r.dname, counterAccountCode: r.ccode, partyCode: null, checks: [{ code: r.dcode, kind: r.dkind }, { code: r.ccode, kind: r.ckind }] }, r.amount.times(sign));
    }
  }
  const out = [...rows.values()].filter((r) => !r.amount.isZero())
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode) || (a.partyCode ?? '').localeCompare(b.partyCode ?? '') || (a.counterAccountCode ?? '').localeCompare(b.counterAccountCode ?? ''));
  // Danh sách theo đối tượng/tài khoản tiết lộ công nợ và giá vốn từng bên: cùng cờ nhạy cảm với sổ sách.
  for (const r of out) for (const c of r.checks) assertSensitive(auth, { subledger_kind: c.kind, code: c.code });
  return { accounts: out.map((r) => ({ accountCode: r.accountCode, accountName: r.accountName, ...(r.counterAccountCode !== undefined && { counterAccountCode: r.counterAccountCode }), partyCode: r.partyCode, amount: r.amount.toString() })) };
}

export interface ReportLineInput { lineCode: string; label: string; parentLineCode: string | null; source: Source; side: Side; formula: string | null; isBold: boolean; negate: boolean; noteRef: string | null }

// Lưu toàn bộ dòng của một báo cáo. Kiểm tra trước khi ghi: cú pháp công thức, dòng [x] tồn tại, không vòng lặp (chạy thử với bộ giải trả 0), mã dòng không trùng, dòng cha tồn tại.
export async function saveReportDef(trx: Trx, tenantId: string, regime: string, reportCode: string, lines: ReportLineInput[]): Promise<void> {
  await evaluateReport(lines.map((l) => ({ lineCode: l.lineCode, formula: l.formula, source: l.source, side: l.side })), { account: async () => ZERO, pair: async () => ZERO });
  const codes = new Set(lines.map((l) => l.lineCode));
  if (codes.size !== lines.length) throw new AppError('VALIDATION', 'Mã dòng bị trùng', 400);
  for (const l of lines) if (l.parentLineCode && !codes.has(l.parentLineCode)) throw new AppError('VALIDATION', `Dòng ${l.lineCode}: không có dòng cha ${l.parentLineCode}`, 400);
  const f = formNoFor(regime, reportCode);
  const d = await trx.insertInto('report_def').values({ tenant_id: tenantId, regime, report_code: reportCode, name: REPORT_NAMES[reportCode]?.[regime] ?? reportCode, form_no: f.formNo, issued_by: f.issuedBy })
    .onConflict((oc) => oc.columns(['tenant_id', 'regime', 'report_code']).doUpdateSet({ name: sql`report_def.name` })).returning('id').executeTakeFirstOrThrow(); // cập nhật giả để RETURNING trả id của định nghĩa đã có
  await trx.deleteFrom('report_line').where('report_def_id', '=', d.id).execute();
  if (lines.length) await trx.insertInto('report_line').values(lines.map((l, i) => ({ tenant_id: tenantId, report_def_id: d.id, line_code: l.lineCode, label: l.label, parent_line_code: l.parentLineCode, source: l.source, side: l.side,
    formula: l.formula, sort_order: i + 1, is_bold: l.isBold, negate: l.negate, note_ref: l.noteRef }))).execute();
}
