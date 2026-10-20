import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LookupSelect, type LookupRow } from '../src/LookupSelect.js';

describe('LookupSelect', () => {
  it('tải danh sách theo từ khóa và trả mã khi chọn; có mục Thêm nhanh', async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: '1', code: 'KH001', name: 'Alpha' }]);
    const onChange = vi.fn();
    render(<LookupSelect catalog="party" fetcher={fetcher} onChange={onChange} quickAddFields={[{ key: 'code', label: 'Mã' }, { key: 'name', label: 'Tên' }]} aria-label="dt" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('', expect.any(AbortSignal)));
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
    await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith('alp', expect.any(AbortSignal)));
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

  it('phản hồi về muộn của lần gõ cũ không ghi đè kết quả mới; yêu cầu cũ bị hủy', async () => {
    const signals: AbortSignal[] = [];
    const reply = (q: string, delay: number, rows: LookupRow[]) => new Promise<LookupRow[]>((resolve) => { setTimeout(() => resolve(rows), delay); void q; });
    const fetcher = vi.fn((q: string, signal: AbortSignal) => {
      signals.push(signal);
      if (q === 'a') return reply(q, 300, [{ id: '1', code: 'A1', name: 'Cũ' }]);
      if (q === 'ab') return reply(q, 10, [{ id: '2', code: 'AB1', name: 'Mới' }]);
      return Promise.resolve([]);
    });
    render(<LookupSelect catalog="party" fetcher={fetcher} />);
    const box = screen.getByRole('combobox');
    await userEvent.type(box, 'a');
    await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith('a', expect.any(AbortSignal))); // sau 250 ms
    await userEvent.type(box, 'b');
    await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith('ab', expect.any(AbortSignal)));
    expect(await screen.findByText('AB1 - Mới')).toBeInTheDocument();
    expect(signals[1]!.aborted).toBe(true); // lần 'a' (signals[0] là lần nạp đầu) bị hủy khi lần 'ab' bắt đầu
    await new Promise((r) => setTimeout(r, 350)); // chờ phản hồi 'a' về muộn
    expect(screen.queryByText('A1 - Cũ')).not.toBeInTheDocument();
    expect(screen.getByText('AB1 - Mới')).toBeInTheDocument();
  });

  it('gõ liên tục chỉ gọi một lần sau 250 ms; gỡ thành phần thì hủy hẹn giờ và yêu cầu đang chạy', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn((_q: string, signal: AbortSignal) => { signals.push(signal); return new Promise<LookupRow[]>(() => undefined); });
    const { unmount } = render(<LookupSelect catalog="party" fetcher={fetcher} />);
    expect(fetcher).toHaveBeenCalledTimes(1); // nạp đầu
    await userEvent.type(screen.getByRole('combobox'), 'abc', { delay: 20 });
    expect(fetcher).toHaveBeenCalledTimes(1); // chưa tới 250 ms
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenLastCalledWith('abc', expect.any(AbortSignal));
    await userEvent.type(screen.getByRole('combobox'), 'd'); // hẹn giờ mới
    unmount();
    await new Promise((r) => setTimeout(r, 350));
    expect(fetcher).toHaveBeenCalledTimes(2); // hẹn giờ đã bị hủy
    expect(signals[1]!.aborted).toBe(true);
  });

  it('lỗi tải (không phải hủy) thì danh sách rỗng, ghi log và không làm sập', async () => {
    const err = new Error('Mất kết nối');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetcher = vi.fn().mockRejectedValue(err);
    render(<LookupSelect catalog="party" fetcher={fetcher} />);
    await waitFor(() => expect(log).toHaveBeenCalledWith(err));
    await userEvent.click(screen.getByRole('combobox'));
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    log.mockRestore();
  });

  describe('mặc định gọi API danh mục', () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    const stub = () => { const f = vi.fn(async () => ({ ok: true, json: async () => ({ rows: [{ id: '1', code: 'KH1', name: 'Còn dùng', is_active: true }, { id: '2', code: 'KH2', name: 'Cũ', is_active: false }] }) })); vi.stubGlobal('fetch', f); return f; };
    it('mặc định chỉ lấy mã đang dùng', async () => {
      const f = stub();
      render(<LookupSelect catalog="party" />);
      await waitFor(() => expect(f).toHaveBeenCalled());
      expect((f.mock.calls[0] as unknown as [string])[0]).not.toContain('active=');
    });
    it('includeInactive: lấy cả mã ngưng dùng và ghi rõ "(ngưng dùng)"', async () => {
      const f = stub();
      render(<LookupSelect catalog="party" includeInactive />);
      await waitFor(() => expect(f).toHaveBeenCalled());
      expect((f.mock.calls[0] as unknown as [string])[0]).toContain('active=all');
      await userEvent.click(screen.getByRole('combobox'));
      expect(await screen.findByText('KH2 - Cũ (ngưng dùng)')).toBeInTheDocument();
      expect(screen.getByText('KH1 - Còn dùng')).toBeInTheDocument();
    });
  });
});
