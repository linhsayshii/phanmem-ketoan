import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthCard } from '../src/AuthCard.js';

describe('AuthCard', () => {
  it('render tên sản phẩm, tiêu đề h1 và nội dung', () => {
    render(<AuthCard title="Đăng nhập"><button type="button">Đăng nhập</button></AuthCard>);
    expect(screen.getByText('Phần mềm kế toán')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1, name: 'Đăng nhập' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Đăng nhập' })).toBeDefined();
  });
});
