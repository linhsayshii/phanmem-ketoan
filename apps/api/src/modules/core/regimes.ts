import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { accountingRegimeRules, checkRegimeForYear, isRegimeReady, regimeReportsReady, regimeStatus, type BookRegime } from '@kt/coa-data';

// Danh sách chế độ kế toán và cổng dữ liệu pháp lý. TT58 và TT152 (data/regimes/status.json) ghi sổ theo nhóm thuế, không có hệ thống tài khoản: ready = sổ bắt buộc đã nhập từ văn bản gốc; `limits` nêu phần còn thiếu. TT200 ready=false (hệ thống tài khoản chưa đối chiếu) và hết hiệu lực từ năm 2026: tạo năm trả 409 REGIME_NOT_READY / REGIME_NOT_EFFECTIVE trừ khi xác nhận rõ (accounting.json).
const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/regimes', { preHandler: app.requireAuth }, async () => {
    // ready và hiệu lực lấy từ data/regimes/accounting.json (và cổng TT99): không còn viết cứng true.
    const rules = accountingRegimeRules();
    const full = (['TT99', 'TT133', 'TT200'] as const).map((code) => {
      const rc = checkRegimeForYear(code, '2026-01-01'); const r = rules[code];
      return { code, label: r.label, ready: rc.ready, kind: 'accounts' as const, gates: null, applicable: null, reportsReady: true, limits: [] as string[], missing: [...r.missing, ...(code === 'TT99' ? rc.notReady : [])], note: r.source, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo };
    });
    const books = (Object.entries(regimeStatus()) as [BookRegime, ReturnType<typeof regimeStatus>[BookRegime]][]).map(([code, s]) => ({
      code, label: s.label, kind: 'books' as const, ready: isRegimeReady(code), gates: s.gates, applicable: s.applicable, reportsReady: regimeReportsReady(code), limits: s.limits, missing: s.missing, note: s.note,
      effectiveFrom: s.effectiveFrom, replaces: s.replaces, primaryTextObtained: s.primaryTextObtained, booksSecondary: s.booksSecondary, reportsSecondary: s.reportsSecondary, sources: s.sources,
    }));
    return [...full, ...books];
  });
};
export default routes;
