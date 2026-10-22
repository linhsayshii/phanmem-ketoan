import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { AppError } from '../../plugins/errors.js';

export interface Conversion { uomId: number; factor: string }
const FACTOR_RE = /^\d{1,14}(\.\d{1,6})?$/;

// Chuỗi "THUNG=24;HOP=6" → danh sách (ĐVT, hệ số). Sai định dạng, ĐVT không có, trùng ĐVT cơ sở, hệ số <= 0 → UOM_CONVERSION_INVALID (400).
export async function resolveConversions(trx: Transaction<Database>, text: string, baseUomId: number, cache = new Map<string, number>()): Promise<Conversion[]> {
  const bad = (m: string) => new AppError('UOM_CONVERSION_INVALID', m, 400);
  const out: Conversion[] = []; const seen = new Set<string>();
  for (const part of text.split(';').map((x) => x.trim()).filter(Boolean)) {
    const m = /^([^=]+)=(.+)$/.exec(part);
    if (!m) throw bad(`"${part}" sai dạng, nhập MÃ_ĐVT=hệ số, ví dụ THUNG=24`);
    const code = m[1]!.trim(); const factor = m[2]!.trim();
    if (!FACTOR_RE.test(factor) || Number(factor) <= 0) throw bad(`Hệ số "${factor}" của ĐVT ${code} phải là số lớn hơn 0`);
    if (seen.has(code)) throw bad(`ĐVT ${code} nhập hai lần`);
    seen.add(code);
    let id = cache.get(code);
    if (id === undefined) {
      id = (await sql<{ id: number }>`SELECT id FROM uom WHERE code = ${code}`.execute(trx)).rows[0]?.id;
      if (id === undefined) throw bad(`ĐVT "${code}" không có trong danh mục đơn vị tính`);
      cache.set(code, id);
    }
    if (id === baseUomId) throw bad(`ĐVT ${code} là ĐVT cơ sở (hệ số luôn là 1)`);
    out.push({ uomId: id, factor });
  }
  return out;
}

export async function applyConversions(trx: Transaction<Database>, tenantId: string, itemId: number, convs: Conversion[]): Promise<void> {
  for (const c of convs)
    await sql`INSERT INTO item_uom(tenant_id, item_id, uom_id, factor, is_purchase, is_sale) VALUES (${tenantId}::uuid, ${itemId}, ${c.uomId}, ${c.factor}, true, true)
      ON CONFLICT (tenant_id, item_id, uom_id) DO UPDATE SET factor = EXCLUDED.factor`.execute(trx);
}
