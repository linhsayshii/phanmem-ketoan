import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormModal } from '../src/FormModal.js';

// Mẫu thật: mở hộp thoại, bấm Lưu (confirmLoading bật rồi tắt cùng lúc hộp thoại đóng), mở lại: nút phải là "Lưu", không kẹt "loading Lưu".
function Demo() {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await Promise.resolve(); setOpen(false); } finally { setBusy(false); } };
  return (<>
    <button onClick={() => setOpen(true)}>Mở</button>
    <FormModal open={open} title="Hộp thoại" okText="Lưu" cancelText="Bỏ qua" confirmLoading={busy} onOk={() => void save()} onCancel={() => setOpen(false)} destroyOnHidden><p>Nội dung</p></FormModal>
  </>);
}

describe('FormModal', () => {
  afterEach(cleanup);

  it('mở, lưu, mở lại: nút Lưu có tên truy cập "Lưu", không kẹt biểu tượng loading', async () => {
    render(<Demo />);
    let previous: HTMLElement | null = null;
    for (let i = 0; i < 3; i++) {
      await userEvent.click(screen.getByRole('button', { name: 'Mở' }));
      const ok = await screen.findByRole('button', { name: 'Lưu' });
      // forceRender giữ nút ở lần mở trước (jsdom không chạy hiệu ứng thu biểu tượng loading nên tên nút không tự lộ lỗi): mỗi lần mở phải là nút dựng mới.
      if (previous) expect(ok).not.toBe(previous);
      previous = ok;
      expect(screen.queryByRole('button', { name: /loading/i })).not.toBeInTheDocument();
      await userEvent.click(ok);
      await waitFor(() => expect(screen.queryByText('Nội dung')).not.toBeVisible());
    }
  });

  it('truyền footer={null} thì không có chân hộp thoại', async () => {
    render(<FormModal open title="Không chân" footer={null}><p>Nội dung</p></FormModal>);
    expect(await screen.findByText('Nội dung')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lưu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'OK' })).not.toBeInTheDocument();
  });
});
