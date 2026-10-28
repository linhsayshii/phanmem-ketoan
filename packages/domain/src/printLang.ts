// Ngôn ngữ bản in sổ sách, báo cáo (GĐ7 nhóm 2): vi, en hoặc song ngữ "vi / en". Số, ngày luôn giữ định dạng Việt (dd/mm/yyyy, 1.234.567,89).
export const PRINT_LANGS = ['vi', 'en', 'vi-en'] as const;
export type PrintLang = (typeof PRINT_LANGS)[number];
export const PRINT_LANG_LABELS: Record<PrintLang, string> = { vi: 'Tiếng Việt', en: 'English', 'vi-en': 'Song ngữ Việt – Anh' };
export const TRANSLATION_STATUSES = ['draft', 'reviewed'] as const;
export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number];
export const TRANSLATION_STATUS_LABELS: Record<TranslationStatus, string> = { draft: 'Bản nháp', reviewed: 'Đã soát' };
// Ghép hai ngôn ngữ; en rỗng thì rơi về tiếng Việt.
export function bilingual(vi: string, en: string | null | undefined, lang: PrintLang): string {
  if (lang === 'vi' || !en) return vi;
  return lang === 'en' ? en : `${vi} / ${en}`;
}
