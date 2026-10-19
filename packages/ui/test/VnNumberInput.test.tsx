import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VnNumberInput } from '../src/VnNumberInput.js';

describe('VnNumberInput', () => {
  it('hiển thị 1.500.000 và trả chuỗi số thuần khi gõ', () => {
    const onChange = vi.fn();
    render(<VnNumberInput value="1500000" onChange={onChange} aria-label="so" />);
    const input = screen.getByLabelText('so') as HTMLInputElement;
    expect(input.value).toBe('1.500.000');
    fireEvent.focus(input); fireEvent.change(input, { target: { value: '2500000' } }); fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith('2500000'); expect(input.value).toBe('2.500.000');
  });

  it('nhận cả dạng gõ có dấu chấm ngăn cách và để trống thì trả null', () => {
    const onChange = vi.fn();
    render(<VnNumberInput value={null} onChange={onChange} scale={2} aria-label="so" />);
    const input = screen.getByLabelText('so') as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.focus(input); fireEvent.change(input, { target: { value: '1.500.000' } });
    expect(onChange).toHaveBeenLastCalledWith('1500000');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
