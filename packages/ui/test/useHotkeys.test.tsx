import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { useHotkeys } from '../src/useHotkeys.js';

function Page({ onInsert, onSave }: { onInsert: () => void; onSave?: () => void }) {
  useHotkeys({ Insert: onInsert, ...(onSave ? { 'Ctrl+s': onSave } : {}) });
  return <div><input aria-label="tim" /><div className="ant-modal"><button>OK</button></div></div>;
}

describe('useHotkeys', () => {
  it('Insert gọi hàm đã đăng ký; phím khác và Ctrl+Insert thì không', () => {
    const onInsert = vi.fn();
    render(<Page onInsert={onInsert} />);
    fireEvent.keyDown(document.body, { key: 'F2' }); fireEvent.keyDown(document.body, { key: 'Insert', ctrlKey: true });
    expect(onInsert).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Insert' });
    expect(onInsert).toHaveBeenCalledTimes(1);
  });
  it('tổ hợp Ctrl+s; hàm mới nhất luôn được dùng sau khi render lại', () => {
    const a = vi.fn(); const b = vi.fn();
    const { rerender } = render(<Page onInsert={vi.fn()} onSave={a} />);
    rerender(<Page onInsert={vi.fn()} onSave={b} />);
    fireEvent.keyDown(document.body, { key: 'S', ctrlKey: true }); // Caps Lock: vẫn là Ctrl+s
    expect(a).not.toHaveBeenCalled(); expect(b).toHaveBeenCalledTimes(1);
  });
  it('bỏ qua khi đang gõ trong ô nhập, trong hộp thoại hoặc đang soạn chữ bằng bộ gõ; gỡ trang thì ngừng nghe', () => {
    const onInsert = vi.fn();
    const { getByLabelText, getByText, unmount } = render(<Page onInsert={onInsert} />);
    fireEvent.keyDown(getByLabelText('tim'), { key: 'Insert' }); fireEvent.keyDown(getByText('OK'), { key: 'Insert' });
    fireEvent.keyDown(document.body, { key: 'Insert', isComposing: true }); fireEvent.keyDown(document.body, { key: 'Insert', keyCode: 229 });
    expect(onInsert).not.toHaveBeenCalled();
    unmount(); fireEvent.keyDown(document.body, { key: 'Insert' });
    expect(onInsert).not.toHaveBeenCalled();
  });
});
