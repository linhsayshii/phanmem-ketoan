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
  // giá trị hợp lệ cuối cùng (do chủ truyền vào hoặc đã phát ra): rời ô với chữ sai thì trả về đúng giá trị này, để hiển thị luôn khớp với giá trị chủ đang giữ
  const lastValid = useRef(value ?? null);
  useEffect(() => { lastValid.current = value ?? null; if (!focused.current) { setText(formatVnNumber(value ?? null, scale)); setInvalid(false); } }, [value, scale]);
  const emit = (v: string | null) => { lastValid.current = v; onChange?.(v); };
  return (
    <Input {...rest} {...(invalid ? { status: 'error' as const, 'aria-invalid': true } : {})} value={text} style={{ textAlign: 'right', ...(rest.style ?? {}) }} inputMode="decimal"
      onFocus={(e) => { focused.current = true; e.target.select(); rest.onFocus?.(e); }}
      onChange={(e) => {
        const t = e.target.value; dirty.current = true; setText(t);
        if (t.trim() === '') { setInvalid(false); emit(null); return; }
        const p = parseVnNumber(t); setInvalid(p === null); // đang gõ chữ sai thì báo đỏ ngay; rời ô sẽ trả về giá trị hợp lệ cuối
        if (p !== null) emit(rounded(p, scale)); // chữ chưa phân tích được thì giữ nguyên chữ, không phát gì
      }}
      onBlur={(e) => {
        focused.current = false;
        if (dirty.current) {
          dirty.current = false;
          if (text.trim() === '') { setText(''); emit(null); }
          else {
            const p = parseVnNumber(text);
            // chữ không hợp lệ: không phát gì, trả ô về giá trị hợp lệ cuối cùng
            if (p === null) { setText(formatVnNumber(lastValid.current, scale)); setInvalid(false); }
            else { const r = rounded(p, scale); setText(formatVnNumber(r, scale)); emit(r); }
          }
        }
        rest.onBlur?.(e);
      }} />
  );
}
