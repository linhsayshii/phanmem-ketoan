// Xếp hạng gợi ý định khoản: mô hình thống kê/luật cục bộ, xác định, không gọi dịch vụ ngoài. Học từ chứng từ đã ghi sổ của chính công ty.
// Mỗi chứng từ lịch sử có một "chữ ký" = tập (bên, tài khoản) đã dùng. Điểm của chữ ký = tổng điểm các chứng từ cùng chữ ký:
//   điểm chứng từ = (3·cùng đối tượng + 1·cùng loại chứng từ + 0,5·số từ khóa diễn giải chung (tối đa 3) + 2·cùng mặt hàng + 0,5·số tiền gần bằng ±10%) × độ mới
//   độ mới = 1 nếu chứng từ trong 365 ngày gần nhất, ngược lại 0,5. Chứng từ không khớp đặc trưng nào (điểm 0) không tính.
export const WEIGHTS = { party: 3, type: 1, keyword: 0.5, item: 2, amount: 0.5, recent: 1, old: 0.5 } as const;
export const MAX_KEYWORDS = 3;
export const MAX_SIGNATURE = 6;
export const RECENT_DAYS = 365;

export interface HistVoucher {
  id: string; voucherType: string; postingDate: string; partyCodes: string[]; description: string | null; itemCodes: string[]; total: string;
  lines: { side: 'debit' | 'credit'; accountCode: string }[];
}
export interface SuggestQuery { voucherType?: string | undefined; partyCode?: string | undefined; description?: string | undefined; itemCodes?: string[] | undefined; amount?: string | undefined; asOf: string }
export interface Suggestion {
  signature: string; lines: { side: 'debit' | 'credit'; accountCode: string }[]; score: number; confidence: number; support: number;
  samePartyCount: number; sameTypeCount: number; keywordCount: number; itemCount: number; amountCount: number; lastUsed: string; keywords: string[]; reasons: string[]; sampleVoucherIds: string[];
}

const STOP = new Set(['cua', 'va', 'cho', 'tai', 'theo', 'thang', 'nam', 'quy', 'so', 'ngay', 'tu', 'den', 'la', 'the', 'mot', 'cac', 'nay', 'do']);
// Bỏ dấu tiếng Việt, chữ thường, tách từ, bỏ từ ngắn, số thuần và từ dừng.
export function tokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const t = text.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();
  return [...new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !STOP.has(w)))].sort();
}
const dayNum = (iso: string) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000);
const ratioClose = (a: string, b: string): boolean => {
  const x = BigInt(a); const y = BigInt(b);
  if (x === 0n || y === 0n) return false;
  const lo = x < y ? x : y; const hi = x < y ? y : x;
  return lo * 10n >= hi * 9n; // nhỏ/lớn >= 0,9 bằng số nguyên, không dùng số thực
};

export const signatureOf = (lines: HistVoucher['lines']): string => [...new Set(lines.map((l) => `${l.side === 'debit' ? 'N' : 'C'}:${l.accountCode}`))].sort().join('|');

interface Group { signature: string; score: number; support: number; party: number; type: number; kw: number; item: number; amount: number; last: string; kws: Set<string>; ids: { id: string; date: string }[]; lines: HistVoucher['lines'] }

export function rankSuggestions(history: HistVoucher[], q: SuggestQuery, limit = 5): Suggestion[] {
  const qTokens = tokens(q.description); const qItems = new Set(q.itemCodes ?? []);
  const groups = new Map<string, Group>();
  for (const h of history) {
    const sig = signatureOf(h.lines);
    const distinct = sig.split('|');
    if (!sig || distinct.length > MAX_SIGNATURE || !h.lines.some((l) => l.side === 'debit') || !h.lines.some((l) => l.side === 'credit')) continue;
    const party = q.partyCode && h.partyCodes.includes(q.partyCode) ? 1 : 0;
    const type = q.voucherType && h.voucherType === q.voucherType ? 1 : 0;
    const shared = qTokens.length ? tokens(h.description).filter((w) => qTokens.includes(w)) : [];
    const kw = Math.min(shared.length, MAX_KEYWORDS);
    const item = qItems.size && h.itemCodes.some((c) => qItems.has(c)) ? 1 : 0;
    const amount = q.amount && ratioClose(q.amount, h.total) ? 1 : 0;
    const base = party * WEIGHTS.party + type * WEIGHTS.type + kw * WEIGHTS.keyword + item * WEIGHTS.item + amount * WEIGHTS.amount;
    if (base === 0) continue;
    const age = dayNum(q.asOf) - dayNum(h.postingDate);
    const score = base * (age <= RECENT_DAYS ? WEIGHTS.recent : WEIGHTS.old);
    let g = groups.get(sig);
    if (!g) { g = { signature: sig, score: 0, support: 0, party: 0, type: 0, kw: 0, item: 0, amount: 0, last: '', kws: new Set(), ids: [], lines: h.lines.filter((l, i, a) => a.findIndex((m) => m.side === l.side && m.accountCode === l.accountCode) === i) }; groups.set(sig, g); }
    g.score += score; g.support++; g.party += party; g.type += type; g.kw += kw > 0 ? 1 : 0; g.item += item; g.amount += amount;
    for (const w of shared) g.kws.add(w);
    if (h.postingDate > g.last) g.last = h.postingDate;
    g.ids.push({ id: h.id, date: h.postingDate });
  }
  const total = [...groups.values()].reduce((a, g) => a + g.score, 0);
  const sorted = [...groups.values()].sort((a, b) => b.score - a.score || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0) || (a.signature < b.signature ? -1 : 1)).slice(0, limit);
  return sorted.map((g) => {
    const confidence = total > 0 ? Math.round((g.score / total) * 100) / 100 : 0;
    const reasons: string[] = [];
    if (g.party) reasons.push(`Đã dùng ${g.party} lần cho cùng đối tượng ${q.partyCode}`);
    if (g.type) reasons.push(`${g.type} lần trên cùng loại chứng từ ${q.voucherType}`);
    if (g.kw) reasons.push(`${g.kw} lần có diễn giải gần giống (từ khóa: ${[...g.kws].sort().join(', ')})`);
    if (g.item) reasons.push(`${g.item} lần có cùng mặt hàng`);
    if (g.amount) reasons.push(`${g.amount} lần có số tiền gần bằng (chênh dưới 10%)`);
    reasons.push(`Lần gần nhất ${g.last}`, `Chiếm ${Math.round(confidence * 100)}% các bút toán tương tự`);
    return {
      signature: g.signature, lines: g.lines, score: g.score, confidence, support: g.support, samePartyCount: g.party, sameTypeCount: g.type, keywordCount: g.kw, itemCount: g.item, amountCount: g.amount,
      lastUsed: g.last, keywords: [...g.kws].sort(), reasons, sampleVoucherIds: g.ids.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 3).map((x) => x.id),
    };
  });
}
