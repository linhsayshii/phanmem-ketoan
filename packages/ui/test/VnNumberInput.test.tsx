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
    expect(onChange).toHaveBeenLastCalledWith('1500000.00');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('vào ô rồi ra mà không gõ thì không phát gì', () => {
    const onChange = vi.fn();
    render(<VnNumberInput value="1500000" onChange={onChange} aria-label="so" />);
    const input = screen.getByLabelText('so') as HTMLInputElement;
    fireEvent.focus(input); fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled(); expect(input.value).toBe('1.500.000');
  });

  it('chữ không hợp lệ (12.5) được giữ nguyên, báo lỗi và không phát giá trị', () => {
    const onChange = vi.fn();
    render(<VnNumberInput value="1500000" onChange={onChange} aria-label="so" />);
    const input = screen.getByLabelText('so') as HTMLInputElement;
    fireEvent.focus(input); fireEvent.change(input, { target: { value: '12.5' } }); fireEvent.blur(input);
    expect(input.value).toBe('12.5'); expect(input).toHaveClass('ant-input-status-error'); expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.focus(input); fireEvent.blur(input); // vào ra lần nữa không xóa chữ cũng không phát gì
    expect(input.value).toBe('12.5'); expect(input).toHaveClass('ant-input-status-error'); expect(onChange).not.toHaveBeenCalled();
    fireEvent.focus(input); fireEvent.change(input, { target: { value: '1.250' } }); // gõ lại thì hết lỗi
    expect(input).not.toHaveClass('ant-input-status-error');
  });

  it('làm tròn theo scale: 1500000,5 ở scale 0 phát 1500001 và hiển thị 1.500.001', () => {
    const onChange = vi.fn();
    render(<VnNumberInput value={null} onChange={onChange} scale={0} aria-label="so" />);
    const input = screen.getByLabelText('so') as HTMLInputElement;
    fireEvent.focus(input); fireEvent.change(input, { target: { value: '1500000,5' } }); fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith('1500001'); expect(input.value).toBe('1.500.001');
  });

  it('đổi prop value khi không đang gõ thì cập nhật chữ hiển thị', () => {
    const { rerender } = render(<VnNumberInput value="1500000" aria-label="so" />);
    const input = screen.getByLabelText('so') as HTMLInputElement;
    rerender(<VnNumberInput value="2000000" aria-label="so" />);
    expect(input.value).toBe('2.000.000');
    rerender(<VnNumberInput value={null} aria-label="so" />);
    expect(input.value).toBe('');
  });
});
