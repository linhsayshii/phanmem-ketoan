import { useEffect, useRef, useState } from 'react';
import { Input, type InputProps } from 'antd';
import { formatVnNumber, parseVnNumber } from '@kt/domain';

export interface VnNumberInputProps extends Omit<InputProps, 'value' | 'onChange'> { value?: string | null | undefined; onChange?: ((v: string | null) => void) | undefined; scale?: number | undefined }

export function VnNumberInput({ value, onChange, scale = 0, ...rest }: VnNumberInputProps) {
  const [text, setText] = useState(formatVnNumber(value ?? null, scale));
  // ref chứ không phải state: rời ô không được kích hoạt đồng bộ lại về `value` cũ khi chủ chưa cập nhật kịp
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(formatVnNumber(value ?? null, scale)); }, [value, scale]);
  return (
    <Input {...rest} value={text} style={{ textAlign: 'right', ...(rest.style ?? {}) }} inputMode="decimal"
      onFocus={(e) => { focused.current = true; e.target.select(); rest.onFocus?.(e); }}
      onChange={(e) => { setText(e.target.value); const p = e.target.value.trim() === '' ? null : parseVnNumber(e.target.value); if (p !== null || e.target.value.trim() === '') onChange?.(p); }}
      onBlur={(e) => { focused.current = false; const p = parseVnNumber(text); setText(formatVnNumber(p, scale)); onChange?.(p); rest.onBlur?.(e); }} />
  );
}
