import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsersTable } from '../src/pages/Users.js';

describe('Bảng người dùng', () => {
  it('hiển thị tên vai trò và cờ dữ liệu nhạy cảm bằng tiếng Việt', () => {
    render(<UsersTable roles={[{ id: '1', code: 'ketoan_vien', name: 'Kế toán viên' }]}
      users={[{ id: 'u1', username: 'kt1', fullName: 'Kế toán A', roleCode: 'ketoan_vien', sensitiveFlags: ['view_cost'], isActive: true }]} onCreate={vi.fn()} />);
    expect(screen.getByText('Kế toán viên')).toBeInTheDocument();
    expect(screen.getByText('Xem giá vốn')).toBeInTheDocument();
    expect(screen.getByText('Đang dùng')).toBeInTheDocument();
  });
});
