import { Select } from 'antd';
import { PRINT_LANGS, PRINT_LANG_LABELS, type PrintLang } from '@kt/domain';

// Ngôn ngữ bản in (PDF, Excel) của sổ sách và báo cáo tài chính; số và ngày vẫn theo định dạng Việt.
export function PrintLangSelect({ value, onChange }: { value: PrintLang; onChange(v: PrintLang): void }) {
  return <Select style={{ width: 170 }} aria-label="Ngôn ngữ bản in" value={value} onChange={onChange} options={PRINT_LANGS.map((v) => ({ value: v, label: PRINT_LANG_LABELS[v] }))} />;
}
