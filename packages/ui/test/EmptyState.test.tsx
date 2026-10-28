import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from '../src/EmptyState.js';

describe('EmptyState', () => {
  it('render tiêu đề, mô tả và nút hành động', () => {
    render(
      <EmptyState
        title="Chưa có năm tài chính"
        description="Vui lòng tạo năm tài chính để tiếp tục sử dụng."
        action={<button type="button">Tạo năm tài chính</button>}
        testId="empty-fy"
      />,
    );
    expect(screen.getByTestId('empty-fy')).toBeDefined();
    expect(screen.getByText('Chưa có năm tài chính')).toBeDefined();
    expect(screen.getByText('Vui lòng tạo năm tài chính để tiếp tục sử dụng.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Tạo năm tài chính' })).toBeDefined();
  });
});
