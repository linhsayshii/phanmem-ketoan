import { useEffect, useRef, useState } from 'react';
import { Input, type InputProps } from 'antd';
import { D, formatVnNumber, parseVnNumber } from '@kt/domain';

export interface VnNumberInputProps extends Omit<InputProps, 'value' | 'onChange'> { value?: string | null | undefined; onChange?: ((v: string | null) => void) | undefined; scale?: number | undefined }

// Làm tròn theo `scale` bằng Decimal (không dùng số thực JS) để giá trị phát ra khớp đúng giá trị hiển thị.
const rounded = (parsed: string, scale: number): string => D(parsed).toFixed(scale);

export function VnNumberInput({ value, onChange, scale = 0, ...rest }: VnNumberInputProps) {
  const [text, setText] = useState(formatVnNumber(value ?? null, scale));
  const [invalid, setInvalid] = useState(false);
  // ref chứ không phải state: rời ô không được kích hoạt đồng bộ lại về `value` cũ khi chủ chưa cập nhật kịp
  const focused = useRef(false);
  // chỉ phát giá trị khi rời ô nếu người dùng đã gõ; vào rồi ra mà không gõ thì không đổi gì
  const dirty = useRef(false);
  useEffect(() => { if (!focused.current) { setText(formatVnNumber(value ?? null, scale)); setInvalid(false); } }, [value, scale]);
  return (
    <Input {...rest} {...(invalid ? { status: 'error' as const, 'aria-invalid': true } : {})} value={text} style={{ textAlign: 'right', ...(rest.style ?? {}) }} inputMode="decimal"
      onFocus={(e) => { focused.current = true; e.target.select(); rest.onFocus?.(e); }}
      onChange={(e) => {
        const t = e.target.value; dirty.current = true; setText(t); setInvalid(false);
        if (t.trim() === '') { onChange?.(null); return; }
        const p = parseVnNumber(t);
        if (p !== null) onChange?.(rounded(p, scale));
      }}
      onBlur={(e) => {
        focused.current = false;
        if (dirty.current) {
          dirty.current = false;
          if (text.trim() === '') { setText(''); onChange?.(null); }
          else {
            const p = parseVnNumber(text);
            // chữ không hợp lệ thì giữ nguyên để người dùng sửa, đánh dấu lỗi và không phát giá trị
            if (p === null) setInvalid(true);
            else { const r = rounded(p, scale); setText(formatVnNumber(r, scale)); onChange?.(r); }
          }
        }
        rest.onBlur?.(e);
      }} />
  );
}
