import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LookupSelect } from '../src/LookupSelect.js';

describe('LookupSelect', () => {
  it('tải danh sách theo từ khóa và trả mã khi chọn; có mục Thêm nhanh', async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: '1', code: 'KH001', name: 'Alpha' }]);
    const onChange = vi.fn();
    render(<LookupSelect catalog="party" fetcher={fetcher} onChange={onChange} quickAddFields={[{ key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }]} aria-label="dt" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('party', ''));
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByText('KH001 - Alpha'));
    expect(onChange).toHaveBeenCalledWith('KH001', expect.objectContaining({ code: 'KH001' }));
    await userEvent.click(screen.getByRole('combobox'));
    expect(await screen.findByText('+ Thêm nhanh…')).toBeInTheDocument();
  });

  it('gõ từ khóa thì tải lại danh sách theo từ khóa đó', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    render(<LookupSelect catalog="party" fetcher={fetcher} />);
    await userEvent.type(screen.getByRole('combobox'), 'alp');
    await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith('party', 'alp'));
  });

  it('F4 mở danh sách', async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: '1', code: 'KH001', name: 'Alpha' }]);
    render(<LookupSelect catalog="party" fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{F4}');
    expect(await screen.findByText('KH001 - Alpha')).toBeInTheDocument();
  });

  it('Thêm nhanh lưu qua creator và chọn luôn mã vừa tạo', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const creator = vi.fn().mockResolvedValue({ id: '9', code: 'KH002', name: 'Beta' });
    const onChange = vi.fn();
    render(<LookupSelect catalog="party" fetcher={fetcher} creator={creator} onChange={onChange} quickAddFields={[{ key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }]} />);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByText('+ Thêm nhanh…'));
    await userEvent.type(await screen.findByLabelText('Mã'), 'KH002');
    await userEvent.type(screen.getByLabelText('Tên'), 'Beta');
    await userEvent.click(screen.getByRole('button', { name: /OK/ }));
    await waitFor(() => expect(creator).toHaveBeenCalledWith('party', { code: 'KH002', name: 'Beta' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('KH002', expect.objectContaining({ code: 'KH002' })));
  });

  it('Thêm nhanh bị từ chối thì báo lỗi, giữ hộp thoại mở và không chọn gì', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const creator = vi.fn().mockRejectedValue(new Error('Mã đã tồn tại'));
    const onChange = vi.fn();
    render(<LookupSelect catalog="party" fetcher={fetcher} creator={creator} onChange={onChange} quickAddFields={[{ key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }]} />);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByText('+ Thêm nhanh…'));
    await userEvent.type(await screen.findByLabelText('Mã'), 'KH001');
    await userEvent.type(screen.getByLabelText('Tên'), 'Trùng');
    await userEvent.click(screen.getByRole('button', { name: /OK/ }));
    expect(await screen.findByText('Mã đã tồn tại')).toBeInTheDocument();
    expect(creator).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Mã')).toHaveValue('KH001'); // hộp thoại còn mở với dữ liệu đã gõ
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: /OK/ })).toBeEnabled()); // hết trạng thái đang lưu
  });
});
