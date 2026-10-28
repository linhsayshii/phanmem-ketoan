import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, sum, type Decimal } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import type { ReportColumn, ReportDoc } from '../reporting/print/html.js';
import { accountLedger, regimeOf } from '../reporting/ledgers.js';
import { collectCosts, type CollectLine } from './collect.js';
import { getCostRun, isStale } from './costRun.js';

// Báo cáo giá thành (GĐ6 Task 12): thẻ tính giá thành, sổ chi tiết TK 154 theo đối tượng, tổng hợp chi phí sản xuất theo khoản mục/yếu tố, so sánh định mức NVL.
// Kỳ là tháng (giá thành chạy theo tháng). Mọi báo cáo kèm bảng đối chiếu với sổ cái / chứng từ GT; dòng `info` chỉ để tham khảo (không làm đỏ cả bảng).
// Không in "Mẫu số" S37-DN: chưa đối chiếu văn bản gốc (QĐ #850). Đọc trong giao dịch chỉ đọc; tiền là chuỗi đồng nguyên, số lượng tối đa 6 chữ số lẻ.
type Trx = Transaction<Database>;
type Row = Record<string, unknown>;
const year = z.coerce.number().int().min(2000).max(2100);
const month = z.coerce.number().int().min(1).max(12);
const objectId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const reportScope = z.object({ year, month, objectId: objectId.optional() });
export const spanScope = reportScope.extend({ toMonth: month.optional() }).refine((q) => (q.toMonth ?? q.month) >= q.month, { message: 'Đến tháng phải sau hoặc bằng từ tháng', path: ['toMonth'] });
type Scope = z.infer<typeof reportScope>;

export interface Recon { ok: boolean; items: { label: string; report: string; ledger: string; diff: string; info?: boolean }[] }
export interface Report {
  title: string; subtitle: string; sheetName: string; fileName: string; columns: ReportColumn[]; rows: Row[]; footer?: Row; landscape?: boolean; intro: string[];
  reconciliation: Recon; from: string; to: string; year: number; month: number;
}
const mmyyyy = (y: number, m: number) => `${String(m).padStart(2, '0')}/${y}`;
const bounds = (y: number, m: number) => ({ from: `${y}-${String(m).padStart(2, '0')}-01`, to: `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}` });
const s0 = (x: Decimal | string) => D(x).toFixed(0);
const recon = (items: { label: string; report: Decimal; ledger: Decimal; info?: boolean }[]): Recon => {
  const out = items.map((i) => ({ label: i.label, report: s0(i.report), ledger: s0(i.ledger), diff: s0(i.report.minus(i.ledger)), ...(i.info && { info: true }) }));
  return { ok: out.every((i) => i.info || i.diff === '0'), items: out };
};
const num = (key: string, label: string, scale?: number, width?: string): ReportColumn => ({ key, label, type: 'number', ...(scale !== undefined && { scale }), ...(width && { width }) });
const brk = (b: { material: string; labor: string; overhead: string }) => sum([b.material, b.labor, b.overhead]);
const netOf = (s: { debit: string; credit: string }) => D(s.debit).minus(s.credit);

// ---- Thẻ tính giá thành ----
const ELEMENT_ROWS = [['material', 'Chi phí nguyên vật liệu trực tiếp'], ['labor', 'Chi phí nhân công trực tiếp'], ['overhead', 'Chi phí sản xuất chung']] as const;
const METHOD_NAME: Record<string, string> = { simple: 'giản đơn', coefficient: 'hệ số', ratio: 'tỷ lệ', project: 'vụ việc/công trình', order: 'đơn hàng' };

export async function costCard(trx: Trx, tenantId: string, q: Scope): Promise<Report & { stale: boolean; status: string; voucherNo: string | null }> {
  const { from, to } = bounds(q.year, q.month);
  const run = await getCostRun(trx, q.year, q.month); // 404 COST_RUN_NOT_FOUND khi kỳ chưa chạy
  const objs = run.objects.filter((o) => q.objectId === undefined || o.objectId === q.objectId);
  if (q.objectId !== undefined && !objs.length) throw new AppError('NOT_FOUND', 'Đối tượng không có trong lần chạy giá thành của kỳ', 404);
  const stale = await isStale(trx, run);
  const rows: Row[] = []; const tot = { opening: D(0), incurred: D(0), closing: D(0), cost: D(0) };
  const unit = (cost: string, qty: string) => (D(qty).gt(0) ? D(cost).div(qty).toFixed(4) : '');
  for (const o of objs) {
    const one = o.outputs.length <= 1;
    rows.push({ label: `${o.code} — ${o.name} (phương pháp ${METHOD_NAME[o.method] ?? o.method})`, isBold: true });
    for (const [k, label] of ELEMENT_ROWS) rows.push({ label, opening: o.opening[k], incurred: o.incurred[k], closing: o.closing[k], cost: o.cost[k], unitCost: one ? unit(o.cost[k], o.completedQty) : '' });
    rows.push({ label: 'Cộng', qty: o.completedQty, opening: s0(brk(o.opening)), incurred: s0(brk(o.incurred)), closing: s0(brk(o.closing)), cost: o.total, unitCost: one ? unit(o.total, o.completedQty) : '', isBold: true });
    if (!one || o.outputs.some((x) => x.itemCode)) for (const x of o.outputs) rows.push({ label: `Sản phẩm ${x.itemCode ?? o.code}${x.itemName ? ` — ${x.itemName}` : ''}`, qty: x.qty, cost: x.total, unitCost: x.unitCost });
    if (D(o.wipQty).gt(0)) rows.push({ label: `Dở dang cuối kỳ: ${D(o.wipQty).toFixed()} (phương pháp ${o.wipMethod === 'direct_material' ? 'NVL trực tiếp' : 'sản lượng hoàn thành tương đương'})` });
    tot.opening = tot.opening.plus(brk(o.opening)); tot.incurred = tot.incurred.plus(brk(o.incurred));
    tot.closing = tot.closing.plus(brk(o.closing)); tot.cost = tot.cost.plus(o.total);
  }
  // Đối chiếu: phát sinh của thẻ = Nợ 154 trên chứng từ GT (TT99/TT200; TT133 tập hợp thẳng 154 nên không có GT); dở dang cuối so với dư 154 sổ cái chỉ để tham khảo
  // (154 còn nằm ở thành phẩm nhập kho đến khi chạy giá vốn của kỳ).
  const items: Parameters<typeof recon>[0] = [];
  if (run.voucherId) {
    const gt = await sql<{ n: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text AS n FROM voucher_line l JOIN account a ON a.id = l.account_id
      WHERE l.voucher_id = ${run.voucherId}::uuid AND starts_with(a.code, '154') ${q.objectId !== undefined ? sql`AND l.cost_object_id = ${q.objectId}` : sql``}`.execute(trx);
    items.push({ label: `Phát sinh trong kỳ = Nợ TK 154 trên chứng từ giá thành ${run.voucherNo ?? ''}`.trim(), report: tot.incurred, ledger: D(gt.rows[0]!.n) });
  }
  if (q.objectId === undefined) {
    const led = await accountLedger(trx, tenantId, { accountCode: '154', from, to, mode: 'subaccount' });
    items.push({ label: 'Dở dang cuối kỳ theo thẻ = dư cuối TK 154 theo sổ cái (lệch khi chưa chạy giá vốn kho thành phẩm)', report: tot.closing, ledger: netOf(led.closing), info: true });
  }
  const intro = [...(stale ? ['Lần chạy giá thành của kỳ cần chạy lại: chi phí, dở dang đầu kỳ hoặc phiếu nhập kho đã đổi sau lần chạy, số liệu dưới đây là kết quả đã lưu.'] : []),
    ...(run.status === 'unlinked' ? ['Chứng từ giá thành đã bị gỡ: chạy lại giá thành để ghi sổ.'] : []), ...run.warnings];
  return {
    title: 'Thẻ tính giá thành sản phẩm, dịch vụ', subtitle: `Tháng ${mmyyyy(q.year, q.month)}`, sheetName: 'The tinh gia thanh', fileName: `the-tinh-gia-thanh-${q.year}-${String(q.month).padStart(2, '0')}`, landscape: true,
    columns: [{ key: 'label', label: 'Khoản mục chi phí' }, num('qty', 'Sản lượng hoàn thành', 4, '10%'), num('opening', 'Dở dang đầu kỳ'), num('incurred', 'Phát sinh trong kỳ'), num('closing', 'Dở dang cuối kỳ'),
      num('cost', 'Tổng giá thành'), num('unitCost', 'Giá thành đơn vị', 4)],
    rows, footer: { label: 'Tổng cộng', opening: s0(tot.opening), incurred: s0(tot.incurred), closing: s0(tot.closing), cost: s0(tot.cost) },
    intro, reconciliation: recon(items), from, to, year: q.year, month: q.month, stale, status: run.status, voucherNo: run.voucherNo,
  };
}

// ---- Sổ chi tiết tài khoản 154 theo đối tượng ----
// Đối tượng của dòng 154: cost_object_id, rồi đối tượng của vụ việc / hợp đồng; dòng nhập thành phẩm (PNK) và giá vốn (GV) không mang đối tượng (QĐ #805) nên khớp theo vật tư:
// vật tư là đầu ra của đúng một đối tượng trong lần chạy giá thành của tháng ghi sổ. Còn lại vào "Chưa xác định đối tượng".
const OBJECT_OF_LINE = sql`COALESCE(l.cost_object_id,
  (SELECT x.id FROM cost_object x WHERE x.kind = 'project' AND x.project_id = l.project_id),
  (SELECT x.id FROM cost_object x WHERE x.kind = 'contract' AND x.contract_id = l.contract_id),
  (SELECT CASE WHEN count(DISTINCT ro.cost_object_id) = 1 THEN min(ro.cost_object_id) END
     FROM cost_run r JOIN cost_run_output y ON y.run_id = r.id JOIN cost_run_object ro ON ro.id = y.run_object_id
    WHERE l.item_id IS NOT NULL AND y.item_id = l.item_id AND r.year = extract(year FROM l.posting_date) AND r.month = extract(month FROM l.posting_date)))`;
const NONE = 'none';

export async function ledger154(trx: Trx, tenantId: string, q: Scope) {
  const { from, to } = bounds(q.year, q.month);
  const regime = await regimeOf(trx, { from, to });
  const names = new Map((await trx.selectFrom('cost_object').select(['id', 'code', 'name']).execute()).map((o) => [o.id, o]));
  if (q.objectId !== undefined && !names.has(q.objectId)) throw new AppError('NOT_FOUND', 'Không tìm thấy đối tượng tập hợp chi phí', 404);
  const opens = (await sql<{ obj: number | null; net: string }>`SELECT ${OBJECT_OF_LINE} AS obj, sum(l.debit - l.credit)::text AS net
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.state IN ('posted','reversed') AND l.posting_date < ${from}::date AND a.regime = ${regime} AND starts_with(a.code, '154') GROUP BY 1`.execute(trx)).rows;
  const lines = (await sql<{ obj: number | null; postingDate: string; voucherNo: string; description: string | null; contra: string | null; debit: string; credit: string }>`
    SELECT ${OBJECT_OF_LINE} AS obj, l.posting_date::text AS "postingDate", v.voucher_no AS "voucherNo", coalesce(l.description, v.description) AS description, l.debit::text AS debit, l.credit::text AS credit,
      (SELECT string_agg(DISTINCT ca.code, ', ' ORDER BY ca.code) FROM voucher_line c JOIN account ca ON ca.id = c.account_id
        WHERE c.voucher_id = l.voucher_id AND NOT starts_with(ca.code, '154') AND ((l.debit > 0 AND c.credit > 0) OR (l.credit > 0 AND c.debit > 0))) AS contra
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
    WHERE v.state IN ('posted','reversed') AND l.posting_date BETWEEN ${from}::date AND ${to}::date AND a.regime = ${regime} AND starts_with(a.code, '154')
    ORDER BY l.posting_date, v.voucher_type, v.seq_no, v.id, l.line_no`.execute(trx)).rows;
  const led = await accountLedger(trx, tenantId, { accountCode: '154', from, to, mode: 'subaccount' });
  // Dư đầu theo sổ cái (số dư kỳ trước, gồm số dư đầu năm nhập tay không mang chiều) trừ phần đã gán được cho đối tượng → "chưa xác định".
  const open = new Map<string, Decimal>(opens.filter((o) => o.obj !== null).map((o) => [String(o.obj), D(o.net)]));
  open.set(NONE, netOf(led.opening).minus(sum(open.values())));
  const keys = [...new Set([...open.keys(), ...lines.map((l) => (l.obj === null ? NONE : String(l.obj)))])].filter((k) => k === NONE || q.objectId === undefined || Number(k) === q.objectId)
    .sort((a, b) => (a === NONE ? 1 : b === NONE ? -1 : names.get(Number(a))!.code.localeCompare(names.get(Number(b))!.code)));
  const run = await getCostRun(trx, q.year, q.month).catch((e: unknown) => { if (e instanceof AppError && e.code === 'COST_RUN_NOT_FOUND') return null; throw e; });
  const cardClosing = (id: number) => { const o = run?.objects.find((x) => x.objectId === id); return o ? brk(o.closing) : null; };
  const rows: Row[] = []; const objects = []; const tot = { debit: D(0), credit: D(0), closing: D(0) };
  for (const k of keys) {
    const mine = lines.filter((l) => (l.obj === null ? NONE : String(l.obj)) === k);
    const o = open.get(k) ?? D(0); const debit = sum(mine.map((l) => l.debit)); const credit = sum(mine.map((l) => l.credit)); const closing = o.plus(debit).minus(credit);
    if (o.isZero() && !mine.length && closing.isZero()) continue;
    const id = k === NONE ? null : Number(k); const obj = id === null ? null : names.get(id)!;
    const card = id === null ? null : cardClosing(id);
    rows.push({ description: obj ? `Đối tượng: ${obj.code} — ${obj.name}` : 'Chưa xác định đối tượng (số dư đầu kỳ, chứng từ không gắn đối tượng)', isBold: true });
    rows.push({ description: 'Số dư đầu kỳ', balance: s0(o), isBold: true });
    let run2 = o;
    for (const l of mine) { run2 = run2.plus(l.debit).minus(l.credit); rows.push({ postingDate: l.postingDate, voucherNo: l.voucherNo, description: l.description ?? '', contra: l.contra ?? '', debit: l.debit, credit: l.credit, balance: s0(run2) }); }
    rows.push({ description: 'Cộng số phát sinh', debit: s0(debit), credit: s0(credit), isBold: true });
    rows.push({ description: `Số dư cuối kỳ${card !== null ? ` (dở dang cuối theo thẻ giá thành: ${card.toFixed(0)})` : ''}`, balance: s0(closing), isBold: true });
    objects.push({ objectId: id, code: obj?.code ?? null, name: obj?.name ?? 'Chưa xác định đối tượng', opening: s0(o), debit: s0(debit), credit: s0(credit), closing: s0(closing), cardClosing: card === null ? null : card.toFixed(0), diff: card === null ? null : closing.minus(card).toFixed(0) });
    tot.debit = tot.debit.plus(debit); tot.credit = tot.credit.plus(credit); tot.closing = tot.closing.plus(closing);
  }
  const all = q.objectId === undefined;
  const items = all ? [{ label: 'Nợ TK 154 phát sinh = sổ cái', report: tot.debit, ledger: D(led.totalDebit) }, { label: 'Có TK 154 phát sinh = sổ cái', report: tot.credit, ledger: D(led.totalCredit) },
    { label: 'Dư cuối kỳ TK 154 = sổ cái', report: tot.closing, ledger: netOf(led.closing) }] : [];
  const intro = ['Số dư Nợ ghi dương, số dư Có ghi trong ngoặc.', ...(all ? [] : ['Chỉ một đối tượng: chưa đối chiếu với sổ cái TK 154 (bỏ chọn đối tượng để đối chiếu).'])];
  const report: Report = {
    title: 'Sổ chi tiết tài khoản 154 theo đối tượng tập hợp chi phí', subtitle: `Tháng ${mmyyyy(q.year, q.month)}`, sheetName: 'So chi tiet 154', fileName: `so-chi-tiet-154-${q.year}-${String(q.month).padStart(2, '0')}`, landscape: true,
    columns: [{ key: 'postingDate', label: 'Ngày ghi sổ', type: 'date', width: '9%' }, { key: 'voucherNo', label: 'Số chứng từ', width: '11%' }, { key: 'description', label: 'Diễn giải' }, { key: 'contra', label: 'TK đối ứng', width: '9%' },
      num('debit', 'Phát sinh Nợ'), num('credit', 'Phát sinh Có'), num('balance', 'Số dư')],
    rows, footer: { description: 'Tổng cộng', debit: s0(tot.debit), credit: s0(tot.credit), balance: s0(tot.closing) }, intro, reconciliation: recon(items), from, to, year: q.year, month: q.month,
  };
  return { ...report, objects };
}

// ---- Bảng tổng hợp chi phí sản xuất theo khoản mục / yếu tố ----
export async function expenseSummary(trx: Trx, q: z.infer<typeof reportScope> & { toMonth?: number | undefined }): Promise<Report> {
  const last = q.toMonth ?? q.month;
  const groups = new Map<string, { id: number | null; code: string; name: string; lines: Map<string, CollectLine> }>();
  const collected = new Map<number, number>(); // tháng → tổng chi phí tập hợp (để đối chiếu lần chạy)
  for (let m = q.month; m <= last; m++) {
    const c = await collectCosts(trx, { year: q.year, month: m, objectId: q.objectId });
    collected.set(m, sum([...c.objects.map((o) => o.amount), c.unassigned.amount]).toNumber());
    for (const g of [...c.objects.map((o) => ({ id: o.id as number | null, code: o.code, name: o.name, lines: o.lines })), { id: null, code: '', name: 'Chưa gắn đối tượng', lines: c.unassigned.lines }]) {
      if (g.id === null && q.objectId !== undefined) continue;
      const cur = groups.get(String(g.id)) ?? groups.set(String(g.id), { id: g.id, code: g.code, name: g.name, lines: new Map() }).get(String(g.id))!;
      for (const l of g.lines) {
        const key = `${l.accountCode}|${l.costItemCode ?? ''}|${l.element ?? ''}`; const old = cur.lines.get(key);
        cur.lines.set(key, old ? { ...old, amount: D(old.amount).plus(l.amount).toFixed(0) } : l);
      }
    }
  }
  const E = ['material', 'labor', 'overhead', 'unclassified'] as const;
  const rows: Row[] = []; const tot: Record<string, Decimal> = { material: D(0), labor: D(0), overhead: D(0), unclassified: D(0) };
  const ordered = [...groups.values()].filter((g) => g.lines.size).sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : a.code.localeCompare(b.code)));
  for (const g of ordered) {
    const ls = [...g.lines.values()]; const e = (k: string) => sum(ls.filter((l) => (l.element ?? 'unclassified') === k).map((l) => l.amount));
    rows.push({ label: g.id === null ? g.name : `${g.code} — ${g.name}`, material: s0(e('material')), labor: s0(e('labor')), overhead: s0(e('overhead')), unclassified: s0(e('unclassified')), total: s0(sum(ls.map((l) => l.amount))), isBold: true });
    for (const l of ls) rows.push({ label: `  TK ${l.accountCode}${l.costItemName ? ` — ${l.costItemName}` : ''}`, [l.element ?? 'unclassified']: l.amount, total: l.amount });
    for (const k of E) tot[k] = tot[k]!.plus(e(k));
  }
  // Đối chiếu với các lần chạy giá thành trong khoảng (phát sinh của lần chạy gồm 627 phân bổ): lệch nghĩa là chi phí đổi sau khi chạy, cần chạy lại.
  const items: Parameters<typeof recon>[0] = [];
  if (q.objectId === undefined) {
    const runs = (await sql<{ month: number; s: string }>`SELECT r.month, sum(o.incurred_material + o.incurred_labor + o.incurred_overhead)::text AS s FROM cost_run r JOIN cost_run_object o ON o.run_id = r.id
      WHERE r.year = ${q.year} AND r.month BETWEEN ${q.month} AND ${last} GROUP BY 1`.execute(trx)).rows;
    if (runs.length) items.push({ label: `Chi phí tập hợp = phát sinh theo lần chạy giá thành (${runs.length} tháng đã chạy)`, report: sum(runs.map((r) => String(collected.get(r.month) ?? 0))), ledger: sum(runs.map((r) => r.s)) });
  }
  const span = last === q.month ? `Tháng ${mmyyyy(q.year, q.month)}` : `Từ tháng ${mmyyyy(q.year, q.month)} đến tháng ${mmyyyy(q.year, last)}`;
  return {
    title: 'Bảng tổng hợp chi phí sản xuất theo khoản mục', subtitle: span, sheetName: 'Tong hop chi phi SX', fileName: `tong-hop-chi-phi-san-xuat-${q.year}-${String(q.month).padStart(2, '0')}${last === q.month ? '' : `-${String(last).padStart(2, '0')}`}`, landscape: true,
    columns: [{ key: 'label', label: 'Đối tượng / Tài khoản - khoản mục' }, num('material', 'Nguyên vật liệu trực tiếp'), num('labor', 'Nhân công trực tiếp'), num('overhead', 'Sản xuất chung'), num('unclassified', 'Chưa phân loại'), num('total', 'Cộng')],
    rows, footer: { label: 'Tổng cộng', ...Object.fromEntries(E.map((k) => [k, s0(tot[k]!)])), total: s0(sum(Object.values(tot))) },
    intro: ['Phát sinh Nợ trừ Có của TK 621, 622, 627 (TT133: TK 154) theo đối tượng, không gồm chứng từ kết chuyển và chứng từ giá thành.'], reconciliation: recon(items), from: bounds(q.year, q.month).from, to: bounds(q.year, last).to, year: q.year, month: q.month,
  };
}

// ---- So sánh định mức nguyên vật liệu ----
// Thực tế: Nợ − Có TK 621 có mã vật tư của đối tượng trong tháng (giá trị) và số lượng từ phiếu kho của cùng chứng từ (xuất − nhập; chứng từ có nhiều dòng 621 cùng vật tư chia số lượng theo giá trị).
// Định mức: cost_norm hiệu lực trong tháng (theo sản phẩm đầu ra, không có thì theo đối tượng; nhiều định mức thì lấy cái hiệu lực ở cuối tháng, rồi cái mới nhất) × sản lượng hoàn thành của lần chạy,
// gồm hao hụt. Giá chuẩn = đơn giá bình quân gia quyền của vật tư trong tháng trên mọi lần xuất cho sản xuất (danh mục chưa có giá định mức, QĐ #854).
export async function normCompare(trx: Trx, q: Scope): Promise<Report> {
  const { from, to } = bounds(q.year, q.month);
  const regime = await regimeOf(trx, { from, to });
  const head = { title: 'Báo cáo so sánh định mức nguyên vật liệu', subtitle: `Tháng ${mmyyyy(q.year, q.month)}`, sheetName: 'So sanh dinh muc', fileName: `so-sanh-dinh-muc-${q.year}-${String(q.month).padStart(2, '0')}`, landscape: true, from, to, year: q.year, month: q.month };
  const columns: ReportColumn[] = [{ key: 'label', label: 'Đối tượng / Nguyên vật liệu' }, { key: 'uom', label: 'ĐVT', width: '5%' }, num('standardQty', 'Định mức (gồm hao hụt)', 4), num('actualQty', 'Thực tế', 4), num('qtyDiff', 'Chênh lệch SL', 4),
    num('qtyDiffPct', '% so định mức', 2), num('actualPrice', 'Đơn giá thực tế', 4), num('standardPrice', 'Đơn giá chuẩn (bình quân kỳ)', 4), num('actualValue', 'Giá trị thực tế'), num('standardValue', 'Giá trị theo định mức'),
    num('qtyVariance', 'CL do lượng'), num('priceVariance', 'CL do giá'), num('totalVariance', 'Tổng chênh lệch')];
  if (regime === 'TT133') return { ...head, columns, rows: [], intro: ['Chế độ TT133 không có TK 621: chi phí nguyên vật liệu ghi thẳng TK 154 nên không so sánh được số lượng xuất với định mức.'], reconciliation: recon([]) };
  const run = await getCostRun(trx, q.year, q.month);
  const objs = run.objects.filter((o) => q.objectId === undefined || o.objectId === q.objectId);
  if (q.objectId !== undefined && !objs.length) throw new AppError('NOT_FOUND', 'Đối tượng không có trong lần chạy giá thành của kỳ', 404);

  const normRows = await trx.selectFrom('cost_norm as n').leftJoin('item as pi', 'pi.id', 'n.item_id').leftJoin('cost_object as po', 'po.id', 'n.cost_object_id')
    .select(['n.id', 'pi.code as itemCode', 'po.code as objectCode', 'n.valid_from as validFrom', 'n.valid_to as validTo'])
    .where('n.valid_from', '<=', to).where((eb) => eb.or([eb('n.valid_to', 'is', null), eb('n.valid_to', '>=', from)])).execute();
  const normLines = normRows.length ? await trx.selectFrom('cost_norm_line as l').innerJoin('item as i', 'i.id', 'l.item_id').leftJoin('uom as u', 'u.id', 'i.base_uom_id')
    .select(['l.norm_id', 'i.code', 'i.name', 'u.code as uom', 'l.quantity', 'l.loss_percent']).where('l.norm_id', 'in', normRows.map((n) => n.id)).orderBy('l.line_no').execute() : [];
  const pick = (key: 'itemCode' | 'objectCode', code: string | null) => code === null ? undefined : normRows.filter((n) => n[key] === code)
    .sort((a, b) => Number(a.validTo !== null && a.validTo < to) - Number(b.validTo !== null && b.validTo < to) || (a.validFrom < b.validFrom ? 1 : -1))[0];

  const actual = (await sql<{ obj: number | null; code: string; name: string; uom: string | null; qty: string | null; value: string }>`
    WITH ln AS (
      SELECT l.voucher_id, l.item_id, o.id AS obj, l.debit - l.credit AS amt
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
      LEFT JOIN cost_object o ON o.id = COALESCE(l.cost_object_id, (SELECT x.id FROM cost_object x WHERE x.kind = 'project' AND x.project_id = l.project_id),
        (SELECT x.id FROM cost_object x WHERE x.kind = 'contract' AND x.contract_id = l.contract_id))
      WHERE v.state IN ('posted','reversed') AND NOT v.is_closing AND v.source_doc_type IS DISTINCT FROM 'cost_run' AND v.source_doc_type IS DISTINCT FROM 'opening_balance'
        AND l.posting_date BETWEEN ${from}::date AND ${to}::date
        AND a.regime = ${regime} AND a.code LIKE '621%' AND l.item_id IS NOT NULL),
    tot AS (SELECT voucher_id, item_id, sum(amt) AS t FROM ln GROUP BY 1, 2),
    mv AS (SELECT voucher_id, item_id, sum(CASE WHEN direction = 'out' THEN quantity ELSE -quantity END) AS q FROM stock_move WHERE voucher_id IN (SELECT voucher_id FROM ln) GROUP BY 1, 2)
    SELECT ln.obj, i.code, i.name, u.code AS uom, sum(CASE WHEN tot.t = 0 THEN 0 ELSE coalesce(mv.q, 0) * ln.amt / tot.t END)::text AS qty, sum(ln.amt)::text AS value
    FROM ln JOIN tot USING (voucher_id, item_id) LEFT JOIN mv USING (voucher_id, item_id) JOIN item i ON i.id = ln.item_id LEFT JOIN uom u ON u.id = i.base_uom_id
    GROUP BY 1, 2, 3, 4`.execute(trx)).rows.map((r) => ({ ...r, qty: D(r.qty ?? '0').toDecimalPlaces(6), value: D(r.value) }));
  const avg = new Map<string, Decimal>(); // đơn giá chuẩn: Σ giá trị ÷ Σ số lượng của vật tư (mọi đối tượng, kể cả chưa gắn)
  for (const code of new Set(actual.map((a) => a.code))) { const xs = actual.filter((a) => a.code === code); const qty = sum(xs.map((a) => a.qty)); avg.set(code, qty.isZero() ? D(0) : sum(xs.map((a) => a.value)).div(qty)); }
  const round0 = (x: Decimal) => x.toDecimalPlaces(0, 4);

  const rows: Row[] = []; const tot = { actual: D(0), standard: D(0), qtyVar: D(0), priceVar: D(0), total: D(0) }; const warnings: string[] = [];
  for (const o of objs) {
    const std = new Map<string, { name: string; uom: string | null; qty: Decimal }>(); let hasNorm = false;
    for (const out of o.outputs) {
      const norm = pick('itemCode', out.itemCode) ?? pick('objectCode', o.code); if (!norm) continue; hasNorm = true;
      for (const l of normLines.filter((x) => x.norm_id === norm.id)) {
        const cur = std.get(l.code) ?? { name: l.name, uom: l.uom, qty: D(0) };
        std.set(l.code, { ...cur, qty: cur.qty.plus(D(l.quantity).times(D(l.loss_percent).div(100).plus(1)).times(out.qty)) });
      }
    }
    if (!hasNorm) warnings.push(`Đối tượng ${o.code} chưa có định mức NVL hiệu lực trong kỳ: chỉ có số thực tế.`);
    if (D(o.wipQty).gt(0) || !brk(o.opening).isZero()) warnings.push(`Đối tượng ${o.code} có dở dang: định mức chỉ tính theo sản lượng hoàn thành, chênh lệch có thể gồm biến động dở dang.`);
    const act = actual.filter((a) => a.obj === o.objectId);
    const codes = [...new Set([...std.keys(), ...act.map((a) => a.code)])].sort();
    if (!codes.length) continue;
    rows.push({ label: `${o.code} — ${o.name}`, isBold: true });
    const sub = { actual: D(0), standard: D(0), qtyVar: D(0), priceVar: D(0), total: D(0) };
    for (const code of codes) {
      const s = std.get(code); const a = act.find((x) => x.code === code); const p = avg.get(code) ?? D(0);
      const stdQty = (s?.qty ?? D(0)).toDecimalPlaces(6); const actQty = a?.qty ?? D(0); const actVal = a?.value ?? D(0);
      const stdVal = round0(stdQty.times(p)); const atStd = round0(actQty.times(p));
      const priceVar = actVal.minus(atStd); const qtyVar = atStd.minus(stdVal); const diff = actQty.minus(stdQty);
      rows.push({ label: `  ${code} — ${s?.name ?? a!.name}${s ? '' : ' (ngoài định mức)'}`, uom: s?.uom ?? a?.uom ?? '', standardQty: stdQty.toFixed(6), actualQty: actQty.toFixed(6), qtyDiff: diff.toFixed(6),
        qtyDiffPct: stdQty.isZero() ? '' : diff.div(stdQty).times(100).toFixed(2), actualPrice: actQty.isZero() ? '' : actVal.div(actQty).toFixed(4), standardPrice: p.toFixed(4),
        actualValue: s0(actVal), standardValue: s0(stdVal), qtyVariance: s0(qtyVar), priceVariance: s0(priceVar), totalVariance: s0(actVal.minus(stdVal)) });
      sub.actual = sub.actual.plus(actVal); sub.standard = sub.standard.plus(stdVal); sub.qtyVar = sub.qtyVar.plus(qtyVar); sub.priceVar = sub.priceVar.plus(priceVar); sub.total = sub.total.plus(actVal.minus(stdVal));
    }
    rows.push({ label: `Cộng ${o.code}`, actualValue: s0(sub.actual), standardValue: s0(sub.standard), qtyVariance: s0(sub.qtyVar), priceVariance: s0(sub.priceVar), totalVariance: s0(sub.total), isBold: true });
    for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] = tot[k].plus(sub[k]);
  }
  const unassigned = actual.filter((a) => a.obj === null);
  if (unassigned.length) warnings.push(`Còn ${unassigned.length} khoản xuất NVL chưa gắn đối tượng (${s0(sum(unassigned.map((a) => a.value)))} đồng): không có trong báo cáo.`);
  // Đối chiếu: giá trị NVL thực tế theo báo cáo = phát sinh TK 621 theo đối tượng của tập hợp chi phí (lệch khi có dòng 621 không mang mã vật tư).
  const col = await collectCosts(trx, { year: q.year, month: q.month, ...(q.objectId !== undefined && { objectId: q.objectId }) });
  const ids = new Set(objs.map((o) => o.objectId));
  const ledger621 = sum(col.objects.filter((o) => ids.has(o.id)).flatMap((o) => o.lines.filter((l) => l.accountCode.startsWith('621')).map((l) => l.amount)));
  return {
    ...head, columns, rows, footer: { label: 'Tổng cộng', actualValue: s0(tot.actual), standardValue: s0(tot.standard), qtyVariance: s0(tot.qtyVar), priceVariance: s0(tot.priceVar), totalVariance: s0(tot.total) },
    intro: ['Chênh lệch do lượng = (thực tế − định mức) × đơn giá chuẩn; chênh lệch do giá = (đơn giá thực tế − đơn giá chuẩn) × số lượng thực tế. Đơn giá chuẩn là đơn giá bình quân gia quyền của vật tư trong tháng (chưa có giá định mức trong danh mục).', ...warnings],
    reconciliation: recon([{ label: 'Giá trị NVL thực tế = phát sinh TK 621 theo đối tượng (tập hợp chi phí)', report: tot.actual, ledger: ledger621 }]),
  };
}

// ---- Tài liệu in / xuất Excel ----
export async function toDoc(trx: Trx, tenantId: string, r: Report): Promise<ReportDoc> {
  const company = await companyInfo(trx, tenantId, await regimeOf(trx, r), null);
  return { title: r.title, subtitle: r.subtitle, sheetName: r.sheetName, columns: r.columns, rows: r.rows, ...(r.footer && { footer: r.footer }), ...(r.landscape && { landscape: true }), intro: r.intro, company, formNo: '', issuedBy: '' };
}
