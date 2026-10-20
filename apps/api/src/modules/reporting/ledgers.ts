import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, sensitiveDenial, sum, SENSITIVE_FLAGS_ALL, ZERO, type Decimal } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';

type Trx = Transaction<Database>;
export interface Side { debit: string; credit: string }
const NIL: Side = { debit: '0', credit: '0' };
const side = (net: Decimal): Side => ({ debit: net.gt(0) ? net.toString() : '0', credit: net.lt(0) ? net.neg().toString() : '0' });
const add = (x: Side, y: Side): Side => ({ debit: D(x.debit).plus(y.debit).toString(), credit: D(x.credit).plus(y.credit).toString() });
const dayBefore = (iso: string) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const POSTED = sql`v.state IN ('posted','reversed')`;

interface Filters { partyId?: string | undefined; costItemId?: number | undefined; projectId?: number | undefined; departmentId?: number | undefined }
// Điều kiện chiều phân tích trên dòng chứng từ gốc (bí danh `alias`); không có bộ lọc thì luôn đúng.
const dimWhere = (alias: string, f: Filters) => sql.join([sql`true`,
  ...(f.partyId ? [sql`${sql.ref(`${alias}.party_id`)} = ${f.partyId}::uuid`] : []),
  ...(f.costItemId !== undefined ? [sql`${sql.ref(`${alias}.cost_item_id`)} = ${f.costItemId}`] : []),
  ...(f.projectId !== undefined ? [sql`${sql.ref(`${alias}.project_id`)} = ${f.projectId}`] : []),
  ...(f.departmentId !== undefined ? [sql`${sql.ref(`${alias}.department_id`)} = ${f.departmentId}`] : [])], sql` AND `);

// Hệ tài khoản của khoảng ngày: kỳ chứa `from`, nếu không có thì kỳ chứa `to`, nếu không có thì kỳ bắt đầu gần nhất trước `to`.
// Một công ty giữ nhiều hệ tài khoản (mã trùng nhau giữa các hệ), nên mọi tra cứu và so khớp tiền tố tài khoản phải gắn với một hệ.
// Kỳ thường đứng trước kỳ 0 (kỳ 0 của năm sau trùng ngày cuối năm), cùng cách chọn kỳ với fn_balances_at.
export async function regimeOf(trx: Trx, f: { from: string; to: string }): Promise<string> {
  const r = await sql<{ regime: string }>`SELECT regime FROM fiscal_period
    ORDER BY (date_from <= ${f.from}::date AND date_to >= ${f.from}::date) DESC, (date_from <= ${f.to}::date AND date_to >= ${f.to}::date) DESC, date_from <= ${f.to}::date DESC,
             period_no = 0, fiscal_year DESC, period_no DESC LIMIT 1`.execute(trx);
  if (!r.rows[0]) throw new AppError('PERIOD_NOT_FOUND', 'Chưa mở năm tài chính nào', 404);
  return r.rows[0].regime;
}

// Tài khoản `code` của hệ `regime` cùng mọi tài khoản con theo tiền tố (sổ của tài khoản tổng hợp gộp các tài khoản con); 404 khi không có chính mã đó.
export async function accountsUnder(trx: Trx, regime: string, code: string) {
  const rows = await trx.selectFrom('account').select(['code', 'name', 'subledger_kind']).where('regime', '=', regime).where(sql<boolean>`starts_with(code, ${code})`).orderBy('code').execute();
  if (!rows.some((a) => a.code === code)) throw new AppError('ACCOUNT_NOT_FOUND', `Không có tài khoản ${code}`, 404);
  return rows;
}

// Số dư ròng (Nợ - Có) cuối ngày trước `from`, theo từng tài khoản của hệ `regime` có số hiệu bắt đầu bằng `prefix`.
async function openingNets(trx: Trx, tenantId: string, regime: string, prefix: string, from: string, partyId?: string): Promise<Map<string, Decimal>> {
  const r = await sql<{ code: string; net: string }>`SELECT a.code, sum(b.debit - b.credit)::text AS net FROM fn_balances_at(${tenantId}::uuid, ${dayBefore(from)}::date) b JOIN account a ON a.id = b.account_id
    WHERE a.regime = ${regime} AND starts_with(a.code, ${prefix}) ${partyId ? sql`AND b.party_id = ${partyId}::uuid` : sql``} GROUP BY a.code`.execute(trx);
  return new Map(r.rows.map((x) => [x.code, D(x.net)]));
}
export async function openingNet(trx: Trx, tenantId: string, regime: string, prefix: string, from: string, filters: { partyId?: string | undefined } = {}): Promise<Decimal> {
  return sum((await openingNets(trx, tenantId, regime, prefix, from, filters.partyId)).values());
}
// Dư đầu hai bên theo đối tượng: dư ròng từng đối tượng (gộp loại tiền) rồi cộng riêng các đối tượng dư Nợ và các đối tượng dư Có.
export async function openingSplit(trx: Trx, tenantId: string, regime: string, prefix: string, from: string): Promise<Side> {
  const r = await sql<{ d: string | null; c: string | null }>`SELECT sum(greatest(x.n, 0))::text AS d, sum(greatest(-x.n, 0))::text AS c FROM (
      SELECT sum(b.debit - b.credit) AS n FROM fn_balances_at(${tenantId}::uuid, ${dayBefore(from)}::date) b JOIN account a ON a.id = b.account_id
      WHERE a.regime = ${regime} AND starts_with(a.code, ${prefix}) GROUP BY b.account_id, b.party_id) x`.execute(trx);
  return { debit: r.rows[0]?.d ?? '0', credit: r.rows[0]?.c ?? '0' };
}
// Dư đầu khi lọc theo khoản mục/vụ việc/bộ phận: số dư kỳ không mang các chiều này, nên cộng trực tiếp các dòng đã ghi sổ trước `from` với cùng bộ lọc.
async function openingFromLines(trx: Trx, regime: string, prefix: string, from: string, filters: Filters): Promise<Decimal> {
  const r = await sql<{ net: string | null }>`SELECT sum(l.debit - l.credit)::text AS net FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE ${POSTED} AND l.posting_date < ${from}::date AND a.regime = ${regime} AND starts_with(a.code, ${prefix}) AND ${dimWhere('l', filters)}`.execute(trx);
  return D(r.rows[0]?.net ?? '0');
}

// Trần số dòng của Nhật ký chung trả JSON cho màn hình; bản in/Excel không bị cắt.
export const JOURNAL_JSON_LIMIT = 50_000;
export async function generalJournal(trx: Trx, f: { from: string; to: string }, limit?: number) {
  const where = sql`${POSTED} AND v.posting_date BETWEEN ${f.from}::date AND ${f.to}::date AND l.posting_date BETWEEN ${f.from}::date AND ${f.to}::date`;
  const rows = await sql<{ postingDate: string; voucherId: string; voucherNo: string; voucherType: string; documentDate: string; description: string | null; accountCode: string; accountName: string; debit: string; credit: string }>`
    SELECT v.posting_date AS "postingDate", v.id AS "voucherId", v.voucher_no AS "voucherNo", v.voucher_type AS "voucherType", v.document_date AS "documentDate", coalesce(l.description, v.description) AS description,
           a.code AS "accountCode", a.name AS "accountName", l.debit::text AS debit, l.credit::text AS credit
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE ${where}
    ORDER BY v.posting_date, v.voucher_type, v.seq_no, l.line_no ${limit === undefined ? sql`` : sql`LIMIT ${limit + 1}`}`.execute(trx); // đọc dư một dòng để biết có bị cắt không
  const truncated = limit !== undefined && rows.rows.length > limit;
  const shown = truncated ? rows.rows.slice(0, limit) : rows.rows;
  // Bị cắt thì tổng vẫn là tổng cả khoảng (không phải tổng các dòng đang hiện).
  const totals = truncated ? (await sql<{ d: string; c: string }>`SELECT coalesce(sum(l.debit), 0)::text AS d, coalesce(sum(l.credit), 0)::text AS c FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id WHERE ${where}`.execute(trx)).rows[0]! : null;
  return { rows: shown, totalDebit: totals?.d ?? sum(shown.map((r) => r.debit)).toString(), totalCredit: totals?.c ?? sum(shown.map((r) => r.credit)).toString(), truncated };
}

// Mỗi cặp đối ứng cho một dòng sổ ở mỗi bên khớp tiền tố: cặp Nợ 1122 / Có 1121 trong sổ 112 cho một dòng Nợ (đối ứng 1121) và một dòng Có (đối ứng 1122).
// Chiều phân tích lấy từ đúng dòng chứng từ gốc của bên đó (debit_line_id / credit_line_id).
async function pairRows(trx: Trx, regime: string, prefix: string, f: { from: string; to: string }, filters: Filters = {}) {
  return (await sql<{ postingDate: string; voucherId: string; voucherNo: string; description: string | null; counterAccountCode: string; debit: string; credit: string; partyCode: string | null; partyName: string | null; costItemCode: string | null; projectCode: string | null; departmentCode: string | null; lineAccountCode: string }>`
    WITH pr AS (
      SELECT p.voucher_id, p.posting_date, ad.code AS dcode, ac.code AS ccode, p.amount, p.debit_line_id, p.credit_line_id
      FROM voucher_pair p JOIN account ad ON ad.id = p.debit_account_id JOIN account ac ON ac.id = p.credit_account_id
      WHERE p.posting_date BETWEEN ${f.from}::date AND ${f.to}::date AND ad.regime = ${regime} AND ac.regime = ${regime} AND (starts_with(ad.code, ${prefix}) OR starts_with(ac.code, ${prefix}))),
    sd AS (
      SELECT pr.voucher_id, pr.posting_date, pr.dcode AS acode, pr.ccode AS counter, pr.amount AS debit, 0 AS credit, pr.debit_line_id AS line_id, 0 AS ord FROM pr WHERE starts_with(pr.dcode, ${prefix})
      UNION ALL
      SELECT pr.voucher_id, pr.posting_date, pr.ccode, pr.dcode, 0, pr.amount, pr.credit_line_id, 1 FROM pr WHERE starts_with(pr.ccode, ${prefix}))
    SELECT s.posting_date AS "postingDate", v.id AS "voucherId", v.voucher_no AS "voucherNo", v.description, s.counter AS "counterAccountCode", s.debit::text AS debit, s.credit::text AS credit,
           pt.code AS "partyCode", pt.name AS "partyName", ci.code AS "costItemCode", pj.code AS "projectCode", dp.code AS "departmentCode", s.acode AS "lineAccountCode"
    FROM sd s JOIN voucher v ON v.id = s.voucher_id
    LEFT JOIN voucher_line ln ON ln.id = s.line_id AND ln.posting_date = s.posting_date
    LEFT JOIN party pt ON pt.id = ln.party_id LEFT JOIN cost_item ci ON ci.id = ln.cost_item_id LEFT JOIN project pj ON pj.id = ln.project_id LEFT JOIN department dp ON dp.id = ln.department_id
    WHERE ${POSTED} AND ${dimWhere('ln', filters)}
    ORDER BY s.posting_date, v.voucher_type, v.seq_no, v.id, ln.line_no, s.counter, s.ord`.execute(trx)).rows;
}

export async function accountLedger(trx: Trx, tenantId: string, f: { accountCode: string; from: string; to: string; mode: 'voucher' | 'subaccount' | 't' }) {
  const regime = await regimeOf(trx, f);
  const accs = await accountsUnder(trx, regime, f.accountCode);
  const opens = await openingNets(trx, tenantId, regime, f.accountCode, f.from);
  const openNet = sum(opens.values());
  const rows = await pairRows(trx, regime, f.accountCode, f);
  const totalDebit = sum(rows.map((r) => r.debit)); const totalCredit = sum(rows.map((r) => r.credit));
  const base = { opening: side(openNet), totalDebit: totalDebit.toString(), totalCredit: totalCredit.toString(), closing: side(openNet.plus(totalDebit).minus(totalCredit)) };
  if (f.mode === 'subaccount') {
    const out = accs.flatMap((a) => {
      const mine = rows.filter((r) => r.lineAccountCode === a.code);
      const o = opens.get(a.code) ?? ZERO; const d = sum(mine.map((r) => r.debit)); const c = sum(mine.map((r) => r.credit));
      return o.isZero() && d.isZero() && c.isZero() ? [] : [{ accountCode: a.code, accountName: a.name, opening: side(o), period: { debit: d.toString(), credit: c.toString() }, closing: side(o.plus(d).minus(c)) }];
    });
    return { ...base, rows: out };
  }
  if (f.mode === 't') {
    const agg = (key: 'debit' | 'credit') => { const m = new Map<string, Decimal>(); for (const r of rows) if (!D(r[key]).isZero()) m.set(r.counterAccountCode, (m.get(r.counterAccountCode) ?? ZERO).plus(r[key])); return [...m].map(([counterAccountCode, a]) => ({ counterAccountCode, amount: a.toString() })).sort((a, b) => a.counterAccountCode.localeCompare(b.counterAccountCode)); };
    return { ...base, debitSide: agg('debit'), creditSide: agg('credit') };
  }
  let run = openNet;
  return { ...base, rows: rows.map((r) => { run = run.plus(r.debit).minus(r.credit); return { ...r, running: side(run) }; }) };
}

export async function accountDetail(trx: Trx, tenantId: string, f: { accountCode: string; from: string; to: string; partyCode?: string | undefined; costItemCode?: string | undefined; projectCode?: string | undefined; departmentCode?: string | undefined }) {
  const regime = await regimeOf(trx, f);
  await accountsUnder(trx, regime, f.accountCode);
  // Mã lọc không có trong danh mục thì báo lỗi, không lặng lẽ bỏ bộ lọc (sẽ ra sổ của mọi đối tượng).
  const id = async (table: 'party' | 'cost_item' | 'project' | 'department', code: string | undefined) => {
    if (!code) return undefined;
    const r = (await trx.selectFrom(table).select('id').where('code', '=', code).executeTakeFirst()) as { id: string | number } | undefined;
    if (!r) throw new AppError('LOOKUP_NOT_FOUND', `Không có mã "${code}" trong danh mục ${table}`, 404);
    return r.id;
  };
  const filters: Filters = { partyId: (await id('party', f.partyCode)) as string | undefined, costItemId: (await id('cost_item', f.costItemCode)) as number | undefined,
    projectId: (await id('project', f.projectCode)) as number | undefined, departmentId: (await id('department', f.departmentCode)) as number | undefined };
  const byDim = filters.costItemId !== undefined || filters.projectId !== undefined || filters.departmentId !== undefined;
  const openNet = byDim ? await openingFromLines(trx, regime, f.accountCode, f.from, filters) : await openingNet(trx, tenantId, regime, f.accountCode, f.from, { partyId: filters.partyId });
  const rows = await pairRows(trx, regime, f.accountCode, f, filters);
  let run = openNet;
  return { opening: side(openNet), rows: rows.map((r) => { run = run.plus(r.debit).minus(r.credit); return { ...r, running: side(run) }; }),
    totalDebit: sum(rows.map((r) => r.debit)).toString(), totalCredit: sum(rows.map((r) => r.credit)).toString(), closing: side(run) };
}

export async function trialBalance(trx: Trx, tenantId: string, f: { from: string; to: string; level?: number | undefined; splitParty?: boolean | undefined }) {
  const regime = await regimeOf(trx, f);
  // Không lọc is_active: tài khoản đã ngừng dùng mà còn số liệu vẫn phải vào bảng, nếu không ba cột không cân.
  const accounts = await trx.selectFrom('account').select(['id', 'code', 'name', 'is_group', 'subledger_kind']).where('regime', '=', regime).orderBy('code').execute();
  // Dư cuối ngày theo tài khoản: ròng, và tách hai bên theo từng đối tượng (dư ròng từng đối tượng gộp loại tiền).
  const balancesAt = async (date: string) => new Map((await sql<{ account_id: number; net: string; d: string; c: string }>`
    SELECT x.account_id, sum(x.n)::text AS net, sum(greatest(x.n, 0))::text AS d, sum(greatest(-x.n, 0))::text AS c
    FROM (SELECT b.account_id, b.party_id, sum(b.debit - b.credit) AS n FROM fn_balances_at(${tenantId}::uuid, ${date}::date) b GROUP BY 1, 2) x GROUP BY 1`.execute(trx)).rows.map((r) => [r.account_id, r]));
  const open = await balancesAt(dayBefore(f.from)); const close = await balancesAt(f.to);
  const mv = new Map((await sql<{ account_id: number; d: string; c: string }>`SELECT l.account_id, sum(l.debit)::text AS d, sum(l.credit)::text AS c FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id
    WHERE ${POSTED} AND v.posting_date BETWEEN ${f.from}::date AND ${f.to}::date AND l.posting_date BETWEEN ${f.from}::date AND ${f.to}::date GROUP BY l.account_id`.execute(trx)).rows.map((r) => [r.account_id, r]));
  const splits = (a: { subledger_kind: string | null }) => !!f.splitParty && ['receivable', 'payable'].includes(a.subledger_kind ?? '');
  const leafSide = (m: typeof open, a: { id: number; subledger_kind: string | null }): Side => {
    const x = m.get(a.id);
    return !x ? NIL : splits(a) ? { debit: x.d, credit: x.c } : side(D(x.net));
  };
  const leaf = new Map<string, { opening: Side; period: Side; closing: Side }>();
  for (const a of accounts.filter((x) => !x.is_group)) leaf.set(a.code, { opening: leafSide(open, a), period: { debit: mv.get(a.id)?.d ?? '0', credit: mv.get(a.id)?.c ?? '0' }, closing: leafSide(close, a) });
  const zero = { opening: NIL, period: NIL, closing: NIL };
  const rows = accounts.map((a) => {
    // Dòng tổng hợp = tổng các tài khoản chi tiết bên dưới (theo tiền tố); dư của tài khoản tổng hợp là dư ròng, trừ khi tách theo đối tượng.
    const kids = a.is_group ? [...leaf].filter(([code]) => code.startsWith(a.code)).map(([, v]) => v) : [leaf.get(a.code)!];
    const agg = kids.reduce((acc, v) => ({ opening: add(acc.opening, v.opening), period: add(acc.period, v.period), closing: add(acc.closing, v.closing) }), zero);
    const netIfGroup = (s: Side) => (a.is_group && !splits(a) ? side(D(s.debit).minus(s.credit)) : s);
    return { accountCode: a.code, accountName: a.name, level: a.code.length <= 3 ? 1 : a.code.length - 2, isGroup: a.is_group, opening: netIfGroup(agg.opening), period: agg.period, closing: netIfGroup(agg.closing) };
  }).filter((r) => [r.opening, r.period, r.closing].some((s) => s.debit !== '0' || s.credit !== '0')).filter((r) => !f.level || r.level <= f.level);
  const totals = rows.filter((r) => r.level === 1).reduce((acc, r) => ({ opening: add(acc.opening, r.opening), period: add(acc.period, r.period), closing: add(acc.closing, r.closing) }), zero);
  return { rows, totals };
}

// Chặn khi cờ nhạy cảm che tài khoản này (lý do lấy từ sensitiveDenial của domain, dùng chung với lọc số dư).
export function assertSensitive(auth: { sensitive: Set<string> }, acc: { subledger_kind: string | null; code: string }) {
  const denied = sensitiveDenial(auth, acc);
  if (denied) throw new AppError('FORBIDDEN', denied, 403);
}
// Sổ tổng hợp (Nhật ký chung, Bảng cân đối số phát sinh) gồm mọi tài khoản, kể cả công nợ và giá vốn: cần đủ cả ba cờ.
export function assertAllSensitive(auth: { sensitive: Set<string> }) {
  if (!SENSITIVE_FLAGS_ALL.every((f) => auth.sensitive.has(f))) throw new AppError('FORBIDDEN', 'Cần quyền xem công nợ phải thu, phải trả và giá vốn để xem sổ tổng hợp', 403);
}

// Kiểm tra cờ nhạy cảm trên chính tài khoản và mọi tài khoản con: sổ của tài khoản tổng hợp cũng chứa số liệu của các tài khoản con.
export async function assertCanView(trx: Trx, auth: { sensitive: Set<string> }, f: { accountCode: string; from: string; to: string }) {
  for (const a of await accountsUnder(trx, await regimeOf(trx, f), f.accountCode)) assertSensitive(auth, a);
}
