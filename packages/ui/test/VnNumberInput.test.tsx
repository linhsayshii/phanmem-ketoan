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

  it('chữ không hợp lệ (12.5): báo lỗi khi đang gõ, không phát giá trị; rời ô thì trả về giá trị hợp lệ trước đó', () => {
    const onChange = vi.fn();
    render(<VnNumberInput value="1500000" onChange={onChange} aria-label="so" />);
    const input = screen.getByLabelText('so') as HTMLInputElement;
    fireEvent.focus(input); fireEvent.change(input, { target: { value: '12.5' } });
    expect(input.value).toBe('12.5'); expect(input).toHaveClass('ant-input-status-error'); expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(input.value).toBe('1.500.000'); expect(input).not.toHaveClass('ant-input-status-error'); expect(onChange).not.toHaveBeenCalled();
    fireEvent.focus(input); fireEvent.change(input, { target: { value: '1.250' } }); // gõ lại thì hết lỗi
    expect(input).not.toHaveClass('ant-input-status-error'); expect(onChange).toHaveBeenLastCalledWith('1250');
  });

  it('gõ "12a" không đẩy 12 ra ngoài; rời ô trả giá trị hợp lệ trước đó', () => {
    const onChange = vi.fn();
    render(<VnNumberInput value="700" onChange={onChange} aria-label="so" />);
    const input = screen.getByLabelText('so') as HTMLInputElement;
    fireEvent.focus(input); fireEvent.change(input, { target: { value: '12a' } });
    expect(input.value).toBe('12a'); expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(input.value).toBe('700'); expect(onChange).not.toHaveBeenCalled();
  });

  it('gõ "12" rồi "12a": rời ô trả về 12, đúng giá trị đã phát ra', () => {
    const onChange = vi.fn();
    render(<VnNumberInput value="700" onChange={onChange} aria-label="so" />); // chủ không cập nhật value
    const input = screen.getByLabelText('so') as HTMLInputElement;
    fireEvent.focus(input); fireEvent.change(input, { target: { value: '12' } }); fireEvent.change(input, { target: { value: '12a' } }); fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1); expect(onChange).toHaveBeenLastCalledWith('12'); expect(input.value).toBe('12');
  });

  it('làm tròn theo scale: 1500000,5 ở scale 0 phát 1500001 và hiển thị 1.500.001', () => {
    const onChange = vi.fn();
    render(<VnNumberInput value={null} onChange={onChange} scale={0} aria-label="so" />);
    const input = screen.getByLabelText('so') as HTMLInputElement;
    fireEvent.focus(input); fireEvent.change(input, { target: { value: '1500000,5' } }); fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith('1500001'); expect(input.value).toBe('1.500.001');
  });

  it('scale 10 (tỷ giá NUMERIC(20,10)): gõ đủ 10 chữ số lẻ phát nguyên văn, hiển thị đủ 10 số lẻ, không mất số', () => {
    const onChange = vi.fn();
    const { rerender } = render(<VnNumberInput value="25000.0000000000" onChange={onChange} scale={10} aria-label="so" />);
    const input = screen.getByLabelText('so') as HTMLInputElement;
    expect(input.value).toBe('25.000,0000000000');
    fireEvent.focus(input); fireEvent.change(input, { target: { value: '25123,1234567891' } }); fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith('25123.1234567891'); expect(input.value).toBe('25.123,1234567891');
    fireEvent.focus(input); fireEvent.change(input, { target: { value: '26000,5' } }); fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith('26000.5000000000'); expect(input.value).toBe('26.000,5000000000');
    rerender(<VnNumberInput value="26000.5000000000" onChange={onChange} scale={10} aria-label="so" />);
    expect(input.value).toBe('26.000,5000000000');
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
