import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useUnsavedChanges } from '../src/useUnsavedChanges.js';

function Probe({ dirty, go }: { dirty: boolean; go: () => void }) {
  const confirmIfDirty = useUnsavedChanges(dirty);
  return <button onClick={() => confirmIfDirty(go)}>Đi</button>;
}

describe('useUnsavedChanges', () => {
  it('không có thay đổi chưa lưu: làm ngay, không hỏi', async () => {
    const go = vi.fn();
    render(<Probe dirty={false} go={go} />);
    await userEvent.click(screen.getByRole('button', { name: 'Đi' }));
    expect(go).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Bỏ thay đổi chưa lưu?')).not.toBeInTheDocument();
  });

  it('có thay đổi chưa lưu: hỏi; Ở lại thì không làm, Tiếp tục thì làm', async () => {
    const go = vi.fn();
    render(<Probe dirty go={go} />);
    await userEvent.click(screen.getByRole('button', { name: 'Đi' }));
    expect(await screen.findByText('Bỏ thay đổi chưa lưu?', { selector: '.ant-modal-confirm-title' })).toBeInTheDocument();
    expect(go).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Ở lại' }));
    expect(go).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Đi' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Tiếp tục' }));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('hỏi hai lần liền khi hộp hỏi còn mở: chỉ một hộp', async () => {
    const go = vi.fn();
    render(<Probe dirty go={go} />);
    await userEvent.dblClick(screen.getByRole('button', { name: 'Đi' }));
    expect(await screen.findAllByText('Bỏ thay đổi chưa lưu?', { selector: '.ant-modal-confirm-title' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('có thay đổi chưa lưu: đóng tab bị trình duyệt hỏi lại', () => {
    render(<Probe dirty go={() => undefined} />);
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});
