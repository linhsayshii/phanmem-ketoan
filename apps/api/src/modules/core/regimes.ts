import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { isRegimeReady, regimeStatus, tt99Status, type BookRegime } from '@kt/coa-data';

// Danh sách chế độ kế toán và cổng dữ liệu pháp lý. TT58 và TT152 chưa có văn bản gốc (data/regimes/status.json): ready=false, giao diện cảnh báo, tạo năm tài chính trả 409 COA_TEMPLATE_PENDING.
const routes: FastifyPluginAsyncZod = async (app) => {
  app.get('/api/regimes', { preHandler: app.requireAuth }, async () => {
    const full = [
      { code: 'TT99', label: 'TT 99/2025/TT-BTC', ready: tt99Status().complete },
      { code: 'TT133', label: 'TT 133/2016/TT-BTC (DNNVV)', ready: true },
      { code: 'TT200', label: 'TT 200/2014/TT-BTC (dữ liệu 2025 trở về trước)', ready: true },
    ].map((r) => ({ ...r, kind: 'accounts' as const, gates: null, missing: [] as string[], note: '' }));
    const books = (Object.entries(regimeStatus()) as [BookRegime, ReturnType<typeof regimeStatus>[BookRegime]][]).map(([code, s]) => ({
      code, label: s.label, kind: 'books' as const, ready: isRegimeReady(code), gates: s.gates, missing: s.missing, note: s.note,
      effectiveFrom: s.effectiveFrom, replaces: s.replaces, primaryTextObtained: s.primaryTextObtained, booksSecondary: s.booksSecondary, reportsSecondary: s.reportsSecondary, sources: s.sources,
    }));
    return [...full, ...books];
  });
};
export default routes;
