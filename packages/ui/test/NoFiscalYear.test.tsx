import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NoFiscalYear } from '../src/NoFiscalYear.js';

describe('NoFiscalYear', () => {
  it('có quyền tạo: hướng dẫn vào Kỳ kế toán và hiện nút Thêm năm tài chính', () => {
    const onCreate = vi.fn();
    render(<NoFiscalYear canCreate onCreate={onCreate} purpose="nhập số dư đầu kỳ" />);
    expect(screen.getByText('Công ty chưa có năm tài chính')).toBeDefined();
    expect(screen.getByText(/Cần có năm tài chính để nhập số dư đầu kỳ\. Vào Kỳ kế toán/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Thêm năm tài chính' }));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('không có quyền tạo: dặn liên hệ quản trị, không có nút', () => {
    render(<NoFiscalYear canCreate={false} onCreate={() => undefined} />);
    expect(screen.getByText(/liên hệ quản trị viên/)).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('bare: bỏ khung Section', () => {
    const { container } = render(<NoFiscalYear canCreate bare />);
    expect(container.querySelector('.ant-card')).toBeNull();
    expect(screen.getByTestId('no-fiscal-year')).toBeDefined();
  });
});
