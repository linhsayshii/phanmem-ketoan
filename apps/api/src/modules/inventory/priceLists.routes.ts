import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { D } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import type { ColumnDef } from '../master/catalogs.js';
import { buildSheetTemplate, readSheet, zodIssueVi, type ImportError } from '../master/excelSheet.js';
import { addLines, createPriceList, deletePriceList, getPriceList, listPriceLists, priceLineInput, priceListInput, resolveByCodes, updatePriceList, type PriceLineInput } from './priceLists.js';

class DryRun extends Error {}
const SHEET = 'Du_lieu'; const KEY_ROW = 2; const FIRST_DATA_ROW = 4; const MAX_ROWS = 20_000; const MAX_ERRORS = 500;
const COLUMNS: ColumnDef[] = [
  { key: 'itemCode', label: 'Mã hàng', type: 'text', required: true }, { key: 'uomCode', label: 'ĐVT', type: 'text', required: true },
  { key: 'minQty', label: 'Từ số lượng', type: 'number' }, { key: 'price', label: 'Đơn giá', type: 'number', required: true }, { key: 'discountRate', label: 'Tỷ lệ chiết khấu (%)', type: 'number' },
];
const id = z.object({ id: z.string().regex(/^\d{1,15}$/) });

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/price-lists', { preHandler: app.requirePermission('price_list.view'), schema: { querystring: z.object({ kind: z.enum(['sale', 'purchase']).optional() }) } },
    async (req) => app.withTenant(req, (trx) => listPriceLists(trx, req.query)));
  app.get('/api/price-lists/resolve', { preHandler: app.requirePermission('price_list.view'), schema: { querystring: z.object({
    kind: z.enum(['sale', 'purchase']), itemCode: z.string().min(1), uomCode: z.string().optional(), partyCode: z.string().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), qty: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/).default('1'), currency: z.string().length(3).default('VND') }) } },
    async (req) => app.withTenant(req, (trx) => resolveByCodes(trx, req.query)));
  app.get('/api/price-lists/lines-template.xlsx', { preHandler: app.requirePermission('price_list.view') }, async (_req, reply) => {
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', 'attachment; filename="mau_dong_gia.xlsx"');
    return reply.send(await buildSheetTemplate({ sheet: SHEET, columns: COLUMNS, keyRow: KEY_ROW, example: (c) => (c.key === 'itemCode' ? 'VI_DU' : c.key === 'uomCode' ? 'CAI' : 0),
      help: [['Mẫu nhập dòng giá'], ['Dòng 3 là ví dụ và luôn bị bỏ qua. Nhập dữ liệu từ dòng 4. Mã hàng và ĐVT phải có trong danh mục.']] }));
  });
  app.get('/api/price-lists/:id', { preHandler: app.requirePermission('price_list.view'), schema: { params: id } }, async (req) => app.withTenant(req, (trx) => getPriceList(trx, req.params.id)));
  app.post('/api/price-lists', { preHandler: app.requirePermission('price_list.create'), schema: { body: priceListInput } },
    async (req, reply) => reply.status(201).send({ id: await app.withTenant(req, (trx) => createPriceList(trx, req.auth!.tenantId!, req.body)) }));
  app.put('/api/price-lists/:id', { preHandler: app.requirePermission('price_list.update'), schema: { params: id, body: priceListInput } },
    async (req) => { await app.withTenant(req, (trx) => updatePriceList(trx, req.auth!.tenantId!, req.params.id, req.body)); return { ok: true }; });
  app.delete('/api/price-lists/:id', { preHandler: app.requirePermission('price_list.delete'), schema: { params: id } },
    async (req, reply) => { await app.withTenant(req, (trx) => deletePriceList(trx, req.params.id)); return reply.status(204).send(); });

  // Nhập Excel dòng giá vào bảng giá có sẵn (thêm dòng; trùng khóa báo lỗi). validate chỉ kiểm tra, commit ghi.
  app.post('/api/price-lists/:id/import-lines', { preHandler: app.requirePermission('price_list.update'), schema: { params: id, querystring: z.object({ mode: z.enum(['validate', 'commit']).default('validate') }) } }, async (req) => {
    const file = await req.file(); if (!file) throw new AppError('IMPORT_NO_FILE', 'Thiếu tệp', 400);
    const sheet = await readSheet(await file.toBuffer(), { sheet: SHEET, keyRow: KEY_ROW, firstDataRow: FIRST_DATA_ROW, maxRows: MAX_ROWS, columns: COLUMNS, strictKeys: true });
    const errors: ImportError[] = [...sheet.errors]; const bad = new Set(errors.map((e) => e.row));
    const rows: { row: number; line: PriceLineInput }[] = [];
    for (const { row, values } of sheet.rows) {
      if (bad.has(row)) continue;
      const p = priceLineInput.safeParse(values);
      if (!p.success) { for (const i of p.error.issues) errors.push({ row, column: String(i.path[0]), message: zodIssueVi(i, COLUMNS.find((c) => c.key === i.path[0])?.label ?? String(i.path[0])) }); } else rows.push({ row, line: p.data });
    }
    const dry = req.query.mode === 'validate';
    try {
      const inserted = await app.withTenant(req, async (trx) => {
        for (const [table, col, key] of [['item', 'itemCode', 'Mã hàng'], ['uom', 'uomCode', 'ĐVT']] as const) {
          const codes = [...new Set(rows.map((r) => r.line[col]))];
          if (!codes.length) continue; // mọi dòng đều lỗi: không có mã để tra (IN () là lỗi cú pháp)
          const found = new Set((await sql<{ code: string }>`SELECT code FROM ${sql.table(table)} WHERE code IN (${sql.join(codes)})`.execute(trx)).rows.map((r) => r.code));
          for (const r of rows) if (!found.has(r.line[col])) errors.push({ row: r.row, column: col, message: `${key} ${r.line[col]} không có trong danh mục` });
        }
        const seen = new Map<string, number>();
        for (const r of rows) { const k = [r.line.itemCode, r.line.uomCode, D(r.line.minQty).toString()].join('|'); if (seen.has(k)) errors.push({ row: r.row, column: 'itemCode', message: `Trùng với dòng ${seen.get(k)}` }); else seen.set(k, r.row); }
        if (errors.length) { if (dry) throw new DryRun(); throw new AppError('IMPORT_ERRORS', `Tệp có ${errors.length} lỗi, chưa nhập dòng nào`, 400, errors.slice(0, MAX_ERRORS)); }
        await addLines(trx, req.auth!.tenantId!, req.params.id, rows.map((r) => r.line));
        if (dry) throw new DryRun();
        return rows.length;
      });
      return { total: rows.length, inserted, errors: [], errorCount: 0 };
    } catch (e) {
      if (dry && e instanceof DryRun) return { total: rows.length + bad.size, inserted: 0, errors: errors.sort((a, b) => a.row - b.row).slice(0, MAX_ERRORS), errorCount: errors.length };
      throw e;
    }
  });
};
export default routes;
