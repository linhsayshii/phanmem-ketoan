import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from '../src/pages/Login.js';

describe('Đăng nhập', () => {
  it('gửi tên đăng nhập và mật khẩu, báo lỗi khi sai', async () => {
    const onLogin = vi.fn().mockRejectedValue(Object.assign(new Error('Sai tên đăng nhập hoặc mật khẩu'), { code: 'BAD_CREDENTIALS' }));
    render(<LoginForm onLogin={onLogin} />);
    await userEvent.type(screen.getByLabelText('Tên đăng nhập'), 'admin');
    await userEvent.type(screen.getByLabelText('Mật khẩu'), 'sai');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(onLogin).toHaveBeenCalledWith({ username: 'admin', password: 'sai' });
    expect(await screen.findByText('Sai tên đăng nhập hoặc mật khẩu')).toBeInTheDocument();
  });
});
