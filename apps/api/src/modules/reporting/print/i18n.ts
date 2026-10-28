import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { bilingual, type PrintLang } from '@kt/domain';
import type { ReportDoc } from './html.js';

// Từ điển nhãn song ngữ của bản in sổ sách, báo cáo: khóa là câu tiếng Việt đúng như builder in ra (bookSet.ts, html.ts), giá trị là tiếng Anh tham khảo.
// Số và ngày giữ định dạng Việt ở mọi ngôn ngữ (quyết định 1050). Câu không có trong từ điển rơi về tiếng Việt.
export const EN: Record<string, string> = {
  // cột
  'Ngày ghi sổ': 'Posting date', 'Số hiệu': 'Document no.', 'Ngày CT': 'Document date', 'Diễn giải': 'Description', 'TK': 'Account',
  'Số phát sinh Nợ': 'Debit turnover', 'Số phát sinh Có': 'Credit turnover', 'TK đối ứng': 'Contra account', 'Nợ': 'Debit', 'Có': 'Credit', 'Ngày': 'Date', 'Đối tượng': 'Party',
  'Số hiệu TK': 'Account no.', 'Tên tài khoản': 'Account name', 'Dư đầu kỳ Nợ': 'Opening debit', 'Dư đầu kỳ Có': 'Opening credit', 'Phát sinh Nợ': 'Debit turnover', 'Phát sinh Có': 'Credit turnover',
  'Dư cuối kỳ Nợ': 'Closing debit', 'Dư cuối kỳ Có': 'Closing credit', 'Chỉ tiêu': 'Item', 'Mã số': 'Code', 'Thuyết minh': 'Notes', 'Số cuối kỳ': 'Closing balance', 'Số đầu năm': 'Opening balance', 'Năm nay': 'Current year', 'Năm trước': 'Previous year',
  // tiêu đề
  'Sổ Nhật ký chung': 'General Journal', 'Bảng cân đối số phát sinh': 'Trial Balance', 'Báo cáo tình hình tài chính': 'Statement of Financial Position', 'Bảng cân đối kế toán': 'Balance Sheet',
  'Báo cáo kết quả hoạt động kinh doanh': 'Income Statement', 'Báo cáo lưu chuyển tiền tệ (phương pháp trực tiếp)': 'Cash Flow Statement (Direct Method)',
  // dòng tổng hợp
  'Số dư đầu kỳ': 'Opening balance', 'Cộng số phát sinh': 'Total turnover', 'Số dư cuối kỳ': 'Closing balance', 'Cộng': 'Total', 'Tổng cộng': 'Grand total',
  // đầu trang, chữ ký
  'MST:': 'Tax code:', 'Mẫu số': 'Form no.', 'Người ghi sổ': 'Bookkeeper', 'Kế toán trưởng': 'Chief accountant', 'Người đại diện theo pháp luật': 'Legal representative', 'Người lập biểu': 'Preparer',
  '(Ký, họ tên)': '(Signature, full name)', '(Ký, họ tên, đóng dấu)': '(Signature, full name, seal)', 'Ngày … tháng … năm …': 'Date … month … year …',
};
export const tr = (vi: string, lang: PrintLang | undefined) => bilingual(vi, EN[vi], lang ?? 'vi');

export const TRANSLATION_NOTE = 'Bản dịch tham khảo, không phải bản dịch chính thức. / Reference translation only, not an official translation.';

type Kind = 'journal' | 'ledger' | 'detail' | 'trial' | 'financial';
// Nhận loại tài liệu qua khóa cột, không phụ thuộc tên sheet hay tiêu đề (hình thức sổ do nhóm khác sửa).
export function inferKind(d: ReportDoc): Kind {
  const k = new Set(d.columns.map((c) => c.key));
  if (k.has('lineCode')) return 'financial';
  if (k.has('accountName')) return 'trial';
  if (k.has('documentDate')) return 'journal';
  return k.has('partyCode') ? 'detail' : 'ledger';
}

type Trx = Transaction<Database>;
const split = (s: string) => /^(\s*)([\s\S]*)$/.exec(s)!.slice(1) as [string, string];
const datePhrase = (s: string, lang: PrintLang) => {
  const en = s.replace(/^Từ ngày (\S+) đến ngày (\S+)$/, 'From $1 to $2').replace(/^Tại ngày (\S+)$/, 'As at $1');
  return bilingual(s, en === s ? null : en, lang);
};

// Dịch một tài liệu đã dựng bằng tiếng Việt: nhãn cột, tiêu đề, kỳ, dòng tổng hợp, chữ ký và tên tài khoản/chỉ tiêu (name_en, label_en của công ty; trống thì tiếng Việt).
export async function localizeDoc(trx: Trx, regime: string, doc: ReportDoc, lang: PrintLang): Promise<ReportDoc> {
  if (lang === 'vi') return doc;
  const kind = inferKind(doc);
  const t = (s: string) => tr(s, lang);
  const rowsOf = doc.rows;
  let title = t(doc.title); let rows = rowsOf;
  const names = new Map<string, string | null>();
  if (kind === 'trial' || kind === 'ledger' || kind === 'detail') {
    const codes = new Set<string>();
    if (kind === 'trial') for (const r of rowsOf) codes.add(String(r['accountCode']));
    const m = /^Sổ Cái – Tài khoản (\S+) –/.exec(doc.title) ?? /^Sổ chi tiết tài khoản (\S+)/.exec(doc.title);
    if (m) codes.add(m[1]!);
    if (codes.size) for (const a of await trx.selectFrom('account').select(['code', 'name_en']).where('regime', '=', regime).where('code', 'in', [...codes]).execute()) names.set(a.code, a.name_en);
  }
  if (kind === 'trial') rows = rowsOf.map((r) => ({ ...r, accountName: bilingual(String(r['accountName']), names.get(String(r['accountCode'])), lang) }));
  else if (kind === 'ledger' || kind === 'detail') {
    const led = /^Sổ Cái – Tài khoản (\S+) – (.*)$/.exec(doc.title);
    const det = /^Sổ chi tiết tài khoản (\S+)(?: – Đối tượng (.+))?$/.exec(doc.title);
    if (led) title = bilingual(doc.title, `General Ledger – Account ${led[1]} – ${names.get(led[1]!) ?? led[2]}`, lang);
    else if (det) title = bilingual(doc.title, `Account detail ledger ${det[1]}${det[2] ? ` – Party ${det[2]}` : ''}`, lang);
  }
  if (kind === 'financial') {
    // Báo cáo nhận diện qua số mẫu của chế độ; chỉ tiêu tra theo mã dòng.
    const def = await trx.selectFrom('report_def').select('id').where('regime', '=', regime).where('form_no', '=', doc.formNo).executeTakeFirst();
    const en = new Map<string, string | null>();
    if (def) for (const l of await trx.selectFrom('report_line').select(['line_code', 'label_en']).where('report_def_id', '=', def.id).execute()) en.set(l.line_code, l.label_en);
    rows = rowsOf.map((r) => { const [pad, text] = split(String(r['label'])); return { ...r, label: pad + bilingual(text, en.get(String(r['lineCode'])), lang) }; });
  }
  const tx = (r: Record<string, unknown>): Record<string, unknown> => ({ ...r, ...(typeof r['description'] === 'string' ? { description: t(r['description']) } : {}), ...(kind === 'trial' && typeof r['accountName'] === 'string' && !('accountCode' in r) ? { accountName: t(r['accountName']) } : {}) });
  return { ...doc, lang, title, subtitle: datePhrase(doc.subtitle, lang), columns: doc.columns.map((c) => ({ ...c, label: t(c.label) })),
    rows: rows.map(tx),
    ...(doc.footer ? { footer: tx(doc.footer) } : {}),
    signatures: (doc.signatures ?? ['Người ghi sổ', 'Kế toán trưởng', 'Người đại diện theo pháp luật']).map(t),
    dateLine: t(doc.dateLine ?? 'Ngày … tháng … năm …'), outro: [...(doc.outro ?? []), TRANSLATION_NOTE] };
}
