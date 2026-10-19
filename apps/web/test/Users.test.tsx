import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../src/api/client.js';
import { UsersTable } from '../src/pages/Users.js';

describe('Bảng người dùng', () => {
  it('hiển thị tên vai trò và cờ dữ liệu nhạy cảm bằng tiếng Việt', () => {
    render(<UsersTable roles={[{ id: '1', code: 'ketoan_vien', name: 'Kế toán viên' }]}
      users={[{ id: 'u1', username: 'kt1', fullName: 'Kế toán A', roleCode: 'ketoan_vien', sensitiveFlags: ['view_cost'], isActive: true }]} onCreate={vi.fn()} />);
    expect(screen.getByText('Kế toán viên')).toBeInTheDocument();
    expect(screen.getByText('Xem giá vốn')).toBeInTheDocument();
    expect(screen.getByText('Đang dùng')).toBeInTheDocument();
  });

  it('giữ nguyên hộp thoại khi tạo người dùng bị API từ chối (409), không phát sinh lỗi chưa xử lý', async () => {
    const onCreate = vi.fn().mockRejectedValue(new ApiError('USERNAME_TAKEN', 'Tên đăng nhập đã tồn tại', 409));
    const user = userEvent.setup({ pointerEventsCheck: 0 }); // bỏ kiểm tra pointer-events: getComputedStyle trong jsdom rất chậm với CSS của Ant Design
    render(<UsersTable roles={[{ id: '1', code: 'ketoan_vien', name: 'Kế toán viên' }]} users={[]} onCreate={onCreate} />);
    await user.click(screen.getByRole('button', { name: 'Thêm người dùng' }));
    const fill = async (label: string, text: string) => { await user.click(await screen.findByLabelText(label)); await user.paste(text); };
    await fill('Tên đăng nhập', 'kt1');
    await fill('Họ tên', 'Kế toán A');
    await fill('Mật khẩu', 'Matkhau123');
    await user.click(screen.getByLabelText('Vai trò'));
    await user.click(await screen.findByTitle('Kế toán viên'));
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ username: 'kt1', fullName: 'Kế toán A', password: 'Matkhau123', roleCode: 'ketoan_vien', sensitiveFlags: [] }));
    await new Promise((r) => setTimeout(r, 50)); // để lời hứa bị từ chối kịp lan ra nếu không được bắt
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByLabelText('Tên đăng nhập')).toHaveValue('kt1');
  });
});
